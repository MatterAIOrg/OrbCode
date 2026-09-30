/**
 * OrbCode harness benchmark.
 *
 *   node --import tsx bench/run.ts --model zai/glm-5.3-flash --label baseline [--reps 2] [--tasks fix-bugs,rename]
 *
 * Runs each task in a fresh fixture repo through the real Agent loop (auto-approve)
 * and records steps, tokens, reasoning time, tool usage, waste and pass/fail.
 * Results land in bench/results/<label>-<model>-<timestamp>.json.
 *
 * Isolation: HOME and MATTERAI_CONFIG_DIR point at a temp dir so sessions,
 * AGENTS.md and skills from the real machine never leak into a run. The login
 * token is read first and passed in explicitly.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { fetchDynamicModels, isValidAxonModel } from "../src/api/models.js"
import { getAuthToken, loadSettings } from "../src/config/settings.js"
import { Agent } from "../src/core/agent.js"
import type { AgentEvent } from "../src/core/events.js"
import { createFixture } from "./fixture.js"
import { VARIANTS } from "./variants.js"
import { type BenchTask, EXTENDED_TASKS, setPristineHashes, TASKS } from "./tasks.js"

const RUN_TIMEOUT_MS = 10 * 60_000
/** Tasks for this run; set from --suite (core | extended | all). */
let activeTasks: BenchTask[] = TASKS

export interface RunMetrics {
	task: string
	kind: string
	model: string
	rep: number
	pass: boolean
	detail: string
	wallMs: number
	steps: number
	toolCalls: number
	toolErrors: number
	toolsByName: Record<string, number>
	/** identical (name+summary) calls repeated within the run */
	repeatedCalls: number
	/** read_file calls whose file had already been read and not edited since */
	redundantReads: number
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	peakContext: number
	reasoningMs: number
	reasoningChars: number
	/** time from start to the first tool call */
	msToFirstTool: number
	cost: number
	/** sum over steps of: request start (prev tool-end / turn start) → first streamed token */
	ttftMs: number
	/** sum over steps of: first streamed token → stream finished (tool-start / end of turn) */
	streamMs: number
	/** sum of tool execution time (tool-start → tool-end), incl. hooks */
	toolMs: number
	/** one entry per model step: what it did and what it cost */
	stepLog: { inputTokens: number; ttftMs: number; thinkMs: number; tools: string[] }[]
	answerChars: number
	timedOut: boolean
	error?: string
}

function arg(name: string, fallback?: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`)
	return i >= 0 ? process.argv[i + 1] : fallback
}

async function runOne(taskIndex: number, model: string, rep: number, token: string, organizationId?: string, baseUrl?: string, variant?: string): Promise<RunMetrics> {
	const task = activeTasks[taskIndex]
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orbbench-${task.id}-`))
	createFixture(dir, { bugs: task.bugs, legacy: task.legacy, big: task.big })
	setPristineHashes(dir)

	const m: RunMetrics = {
		task: task.id,
		kind: task.kind,
		model,
		rep,
		pass: false,
		detail: "",
		wallMs: 0,
		steps: 0,
		toolCalls: 0,
		toolErrors: 0,
		toolsByName: {},
		repeatedCalls: 0,
		redundantReads: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		peakContext: 0,
		reasoningMs: 0,
		reasoningChars: 0,
		msToFirstTool: 0,
		cost: 0,
		ttftMs: 0,
		streamMs: 0,
		toolMs: 0,
		stepLog: [],
		answerChars: 0,
		timedOut: false,
	}

	const start = Date.now()
	const seenCalls = new Set<string>()
	const readFiles = new Set<string>()
	// Step timing, derived purely from the event stream.
	let stepStart = start // when the current model request began
	let firstTokenAt = 0 // first streamed token of the current step
	const toolStartAt = new Map<string, number>()
	let stepTtft = 0
	let stepThink = 0
	const markToken = () => {
		if (!firstTokenAt) {
			firstTokenAt = Date.now()
			stepTtft = firstTokenAt - stepStart
			m.ttftMs += stepTtft
		}
	}
	const markStreamEnd = () => {
		if (firstTokenAt) {
			m.streamMs += Date.now() - firstTokenAt
			firstTokenAt = 0
		}
	}
	let textBuffer = ""
	let lastText = ""
	let completion = ""

	const agent = new Agent({
		cwd: dir,
		token,
		modelId: model,
		organizationId,
		baseUrl,
		systemPromptOverride: variant ? VARIANTS[variant](dir) : undefined,
		autoApproveEdits: true,
		autoApproveSafeCommands: true,
		callbacks: {
			onEvent: (event: AgentEvent) => {
				switch (event.type) {
					case "reasoning-delta":
						markToken()
						m.reasoningChars += event.text.length
						break
					case "reasoning-done":
						m.reasoningMs += event.durationMs
						stepThink += event.durationMs
						break
					case "text-delta":
						markToken()
						textBuffer += event.text
						break
					case "text-done":
						lastText = textBuffer
						textBuffer = ""
						break
					case "stream-reset":
						textBuffer = ""
						break
					case "tool-start": {
						markToken() // tool-only steps emit no earlier token event
						markStreamEnd()
						toolStartAt.set(event.id, Date.now())
						if (m.toolCalls === 0) m.msToFirstTool = Date.now() - start
						m.toolCalls++
						m.toolsByName[event.name] = (m.toolsByName[event.name] ?? 0) + 1
						m.stepLog.at(-1)?.tools.push(event.summary.length > 60 ? `${event.name}: ${event.summary.slice(0, 57)}…` : `${event.name}: ${event.summary}`)
						const key = `${event.name}::${event.summary}`
						if (seenCalls.has(key)) m.repeatedCalls++
						seenCalls.add(key)
						break
					}
					case "tool-end":
						m.toolMs += Date.now() - (toolStartAt.get(event.id) ?? Date.now())
						stepStart = Date.now()
						if (event.isError) m.toolErrors++
						if (event.name === "file_edit" || event.name === "multi_file_edit" || event.name === "file_write") {
							readFiles.clear() // any edit makes earlier reads stale (coarse)
						}
						if (event.name === "read_file") {
							if (readFiles.has(event.summary)) m.redundantReads++
							readFiles.add(event.summary)
						}
						break
					case "usage":
						m.steps++
						m.stepLog.push({ inputTokens: event.inputTokens, ttftMs: stepTtft, thinkMs: stepThink, tools: [] })
						stepThink = 0
						m.inputTokens += event.inputTokens
						m.outputTokens += event.outputTokens
						m.cost += event.cost
						m.peakContext = Math.max(m.peakContext, event.inputTokens + event.outputTokens)
						break
					case "completion":
						markStreamEnd()
						completion = event.result
						break
					case "error":
						m.error = event.message
						break
				}
			},
			requestApproval: async () => "yes",
			requestFollowup: async () => "Proceed with your best judgment; the user is not available to answer.",
		},
	})

	const timer = setTimeout(() => {
		m.timedOut = true
		agent.abort()
	}, RUN_TIMEOUT_MS)
	try {
		await agent.runTurn(task.prompt)
	} catch (error) {
		m.error = (error as Error).message
	} finally {
		clearTimeout(timer)
	}
	markStreamEnd()
	m.wallMs = Date.now() - start
	await agent.endSession("other").catch(() => {})

	const answer = completion || lastText || textBuffer
	m.answerChars = answer.length
	try {
		const verdict = task.verify({ dir, answer })
		m.pass = verdict.pass && !m.timedOut
		m.detail = verdict.detail
	} catch (error) {
		m.detail = `verify crashed: ${(error as Error).message}`
	}
	fs.rmSync(dir, { recursive: true, force: true })
	return m
}

function fmt(n: number, digits = 0): string {
	return n.toFixed(digits)
}

export function printTable(results: RunMetrics[]): void {
	const cols = ["task", "pass", "wall s", "steps", "tools", "err", "dup", "reread", "in k", "out k", "think s", "ttft s", "stream s", "tool s", "cost $"]
	const rows = results.map((r) => [
		r.task + (r.rep > 0 ? `#${r.rep + 1}` : ""),
		r.pass ? "PASS" : "FAIL",
		fmt(r.wallMs / 1000, 1),
		String(r.steps),
		String(r.toolCalls),
		String(r.toolErrors),
		String(r.repeatedCalls),
		String(r.redundantReads),
		fmt(r.inputTokens / 1000, 1),
		fmt(r.outputTokens / 1000, 1),
		fmt(r.reasoningMs / 1000, 1),
		fmt(r.ttftMs / 1000, 1),
		fmt(r.streamMs / 1000, 1),
		fmt(r.toolMs / 1000, 1),
		fmt(r.cost, 4),
	])
	const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((row) => row[i].length)))
	const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ")
	console.log(line(cols))
	console.log(widths.map((w) => "-".repeat(w)).join("  "))
	for (const row of rows) console.log(line(row))
	const sum = (f: (r: RunMetrics) => number) => results.reduce((a, r) => a + f(r), 0)
	console.log(widths.map((w) => "-".repeat(w)).join("  "))
	console.log(
		line([
			"TOTAL",
			`${results.filter((r) => r.pass).length}/${results.length}`,
			fmt(sum((r) => r.wallMs) / 1000, 1),
			String(sum((r) => r.steps)),
			String(sum((r) => r.toolCalls)),
			String(sum((r) => r.toolErrors)),
			String(sum((r) => r.repeatedCalls)),
			String(sum((r) => r.redundantReads)),
			fmt(sum((r) => r.inputTokens) / 1000, 1),
			fmt(sum((r) => r.outputTokens) / 1000, 1),
			fmt(sum((r) => r.reasoningMs) / 1000, 1),
			fmt(sum((r) => r.ttftMs) / 1000, 1),
			fmt(sum((r) => r.streamMs) / 1000, 1),
			fmt(sum((r) => r.toolMs) / 1000, 1),
			fmt(sum((r) => r.cost), 4),
		]),
	)
}

async function main(): Promise<void> {
	const label = arg("label", "run")!
	const reps = Number(arg("reps", "1"))
	const only = arg("tasks")?.split(",")
	const suite = arg("suite", "core")
	if (suite === "extended") activeTasks = EXTENDED_TASKS
	else if (suite === "all") activeTasks = [...TASKS, ...EXTENDED_TASKS]
	else if (suite !== "core") throw new Error(`Unknown suite "${suite}". Known: core, extended, all`)
	const variant = arg("variant")
	if (variant && !VARIANTS[variant]) throw new Error(`Unknown variant "${variant}". Known: ${Object.keys(VARIANTS).join(", ")}`)
	const real = loadSettings()
	const token = getAuthToken(real)
	if (!token) throw new Error("Not signed in: run `orbcode login` or set MATTERAI_TOKEN.")
	const model = arg("model") ?? real.model
	await fetchDynamicModels(token, real.organizationId).catch(() => {})
	if (!isValidAxonModel(model)) throw new Error(`Unknown model "${model}" (would silently fall back to the default).`)

	// Isolate from the real machine (sessions, AGENTS.md, skills, settings).
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "orbbench-home-"))
	process.env.HOME = home
	process.env.MATTERAI_CONFIG_DIR = path.join(home, ".orbcode")

	const results: RunMetrics[] = []
	for (let rep = 0; rep < reps; rep++) {
		for (let i = 0; i < activeTasks.length; i++) {
			if (only && !only.includes(activeTasks[i].id)) continue
			process.stderr.write(`[${label}] ${activeTasks[i].id} rep ${rep + 1}/${reps} on ${model} …\n`)
			const r = await runOne(i, model, rep, token, real.organizationId, real.baseUrl, variant)
			process.stderr.write(`    ${r.pass ? "PASS" : "FAIL"} ${fmt(r.wallMs / 1000, 1)}s ${r.steps} steps — ${r.detail}${r.error ? ` (error: ${r.error})` : ""}\n`)
			results.push(r)
		}
	}
	console.log()
	printTable(results)
	if (process.argv.includes("--steps")) {
		for (const r of results) {
			console.log(`\n${r.task}#${r.rep + 1}`)
			r.stepLog.forEach((st, i) =>
				console.log(`  step ${i + 1}: in ${(st.inputTokens / 1000).toFixed(1)}k ttft ${(st.ttftMs / 1000).toFixed(1)}s think ${(st.thinkMs / 1000).toFixed(1)}s | ${st.tools.join(" ; ") || "(final answer)"}`),
			)
		}
	}

	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "results")
	fs.mkdirSync(outDir, { recursive: true })
	const file = path.join(outDir, `${label}-${model.replace(/[^a-z0-9.]+/gi, "_")}-${Date.now()}.json`)
	fs.writeFileSync(file, JSON.stringify({ label, model, at: new Date().toISOString(), results }, null, 2))
	console.log(`\nSaved ${file}`)
	fs.rmSync(home, { recursive: true, force: true })
	process.exit(0)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
	main().catch((error) => {
		console.error(error)
		process.exit(1)
	})
}
