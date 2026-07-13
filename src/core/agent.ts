import { execSync } from "node:child_process"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type OpenAI from "openai"

import { REASONING_DETAILS_FIELD, type LLMClient } from "../api/llmClient.js"
import { createLLMClient } from "../api/provider.js"
import { buildSystemPrompt } from "../prompts/system.js"
import {
	describeToolCall,
	executeTool,
	getActiveTools,
	getApprovalKind,
	type ToolContext,
} from "../tools/index.js"
import { walkFiles } from "../tools/executors/listFiles.js"
import { previewFileChange } from "../tools/executors/files.js"
import type { AgentCallbacks, AgentEvent, ApprovalDecision } from "./events.js"
import {
	getSessionFilePath,
	saveSession,
	type SessionData,
	type SessionTranscriptEntry,
} from "./sessions.js"
import { HookRunner, type HooksConfig } from "./hooks.js"
import { McpManager } from "../mcp/manager.js"
import { loadMemoryFiles } from "../memory/loader.js"
import { loadSkills } from "../skills/loader.js"
import { renderLinkedReposSection } from "../config/links.js"
import { unifiedDiff } from "../utils/diff.js"

const MAX_STEPS_PER_TURN = 50
const RESULT_PREVIEW_LINES = 6
/** How many times to automatically re-establish a model request that fails
 *  before producing any output (transient/connection errors). */
const MAX_STREAM_RETRIES = 3

/** Transient failures worth auto-retrying: any transport/connection error (no
 *  usable HTTP status — socket reset, DNS, timeout, TLS drop) plus 5xx/408/429
 *  server responses. Real 4xx client errors (auth, bad request) are not retried. */
function isRetryableStreamError(error: unknown): boolean {
	const err = error as { status?: number; code?: number | string }
	const status = Number(err?.status ?? err?.code)
	if (Number.isFinite(status) && status !== 0) {
		return status >= 500 || status === 408 || status === 429
	}
	return true
}

function retryBackoffMs(attempt: number): number {
	return Math.min(500 * 2 ** attempt, 8000)
}

/** Sleep that settles early (rejecting with AbortError) if the signal fires, so
 *  a user interrupt isn't stuck waiting out a retry backoff. */
function interruptibleDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("aborted", "AbortError"))
			return
		}
		const onAbort = () => {
			clearTimeout(timer)
			reject(new DOMException("aborted", "AbortError"))
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolve()
		}, ms)
		signal.addEventListener("abort", onAbort, { once: true })
	})
}

export interface AgentOptions {
	cwd: string
	token: string
	modelId: string
	organizationId?: string
	baseUrl?: string
	autoApproveEdits: boolean
	autoApproveSafeCommands: boolean
	callbacks: AgentCallbacks
	/** restore a previous session instead of starting fresh */
	resume?: SessionData
	/** lifecycle hooks from settings.json */
	hooks?: HooksConfig
	/** MCP server manager (started externally; may be undefined when MCP is off). */
	mcp?: McpManager
	/**
	 * Replace the default system prompt entirely. Set via `orbcode -s <text>`
	 * / `--system-prompt <text>`. The user is responsible for preserving any
	 * critical content (tool guide, environment info, etc.); the agent
	 * receives only the override as its system message.
	 */
	systemPromptOverride?: string
}

interface PendingToolCall {
	id: string
	name: string
	arguments: string
}

function detectRepo(cwd: string): string {
	try {
		const remote = execSync("git config --get remote.origin.url", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
		if (remote) return remote
	} catch {
		// not a git repo or no remote
	}
	return path.basename(cwd)
}

function getGitSummary(cwd: string): string {
	try {
		const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim()
		const status = execSync("git status --short", { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trimEnd()
			.split("\n")
			.slice(0, 20)
			.join("\n")
		return `## Git Repository Information\n- Current Branch: ${branch}\n${status ? `\n### Working Tree Changes\n${status}` : "- Working tree clean"}`
	} catch {
		return ""
	}
}

/**
 * The user's message is wrapped in <user_query> tags internally so the TUI can
 * identify user-authored text when replaying a session. The wrapper is only an
 * internal marker and must be stripped before the message is sent to the model.
 */
function stripUserQueryTags(text: string): string {
	return text.replace(/<user_query>\n?/g, "").replace(/\n?<\/user_query>/g, "")
}

/** Wrap hook-injected context in clearly delimited tags so the model can
 *  distinguish it from user/system content (prompt-injection defense). */
function wrapHookContext(source: string, text: string): string {
	return `<hook_context source="${source}">\n${text}\n</hook_context>`
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) =>
			part && typeof part === "object" && "text" in part
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("")
}

function resultPreview(text: string): string {
	const lines = text.split("\n")
	return (
		lines.slice(0, RESULT_PREVIEW_LINES).join("\n") +
		(lines.length > RESULT_PREVIEW_LINES ? `\n… (${lines.length} lines)` : "")
	)
}

/**
 * Sessions written before display transcripts did not store the full-file diff
 * produced immediately before an edit. The requested old/new fragments are
 * still present in the tool arguments, so use those as an honest best-effort
 * fallback instead of dropping the diff entirely.
 */
function legacyEditDiff(toolName: string, args: Record<string, unknown>): string | undefined {
	const fragment = (filePath: string, oldText: string, newText: string, label: string): string | undefined => {
		const diff = unifiedDiff(oldText, newText)
		return diff ? `${filePath} (${label})\n${diff}` : undefined
	}

	if (toolName === "file_edit") {
		return fragment(
			String(args.file_path ?? "unknown file"),
			String(args.old_string ?? ""),
			String(args.new_string ?? ""),
			"restored edit fragment",
		)
	}

	if (toolName === "file_write") {
		return fragment(
			String(args.file_path ?? "unknown file"),
			"",
			String(args.content ?? ""),
			"restored write; previous contents unavailable",
		)
	}

	if (toolName === "multi_file_edit") {
		const parts = (Array.isArray(args.edits) ? args.edits : []).flatMap((value) => {
			if (!value || typeof value !== "object") return []
			const edit = value as Record<string, unknown>
			const diff = fragment(
				String(edit.file_path ?? "unknown file"),
				String(edit.old_string ?? ""),
				String(edit.new_string ?? ""),
				"restored edit fragment",
			)
			return diff ? [diff] : []
		})
		return parts.length > 0 ? parts.join("\n") : undefined
	}

	return undefined
}

/** Best-effort visible history for sessions written before `transcript`. */
function legacyTranscript(messages: OpenAI.Chat.ChatCompletionMessageParam[]): SessionTranscriptEntry[] {
	const entries: SessionTranscriptEntry[] = []
	const pendingTools = new Map<
		string,
		{ name: string; summary: string; diff?: string }
	>()

	for (const message of messages) {
		if (message.role === "user") {
			const text = contentToText(message.content)
			const match = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(text)
			if (match) entries.push({ kind: "user", text: match[1] })
			continue
		}

		if (message.role === "assistant") {
			const details = (message as unknown as Record<string, unknown>)[REASONING_DETAILS_FIELD]
			if (Array.isArray(details)) {
				const reasoning = details
					.map((part) =>
						part && typeof part === "object" && "text" in part
							? String((part as { text?: unknown }).text ?? "")
							: "",
					)
					.join("")
				if (reasoning.trim()) entries.push({ kind: "reasoning", text: reasoning, durationMs: 0 })
			}

			const text = contentToText(message.content)
			if (text.trim()) entries.push({ kind: "assistant", text })
			for (const call of message.tool_calls ?? []) {
				if (call.type !== "function") continue
				let args: Record<string, unknown> = {}
				try {
					args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>
				} catch {
					// Keep an empty argument object; the call name is still useful history.
				}
				if (call.function.name === "attempt_completion") {
					entries.push({ kind: "completion", text: String(args.result ?? "") })
					continue
				}
				pendingTools.set(call.id, {
					name: call.function.name,
					summary: describeToolCall(call.function.name, args),
					diff: legacyEditDiff(call.function.name, args),
				})
			}
			continue
		}

		if (message.role === "tool") {
			const tool = pendingTools.get(message.tool_call_id)
			if (!tool) continue
			pendingTools.delete(message.tool_call_id)
			const text = contentToText(message.content)
			if (tool.name === "ask_followup_question") {
				const answer = /<answer>\n?([\s\S]*?)\n?<\/answer>/.exec(text)?.[1]
				if (answer) entries.push({ kind: "user", text: answer })
				continue
			}
			const isError = /^(error|failed|tool error|the user denied)\b/i.test(text.trim())
			entries.push({
				kind: "tool",
				name: tool.name,
				summary: tool.summary,
				resultPreview: resultPreview(text),
				isError,
				diff: isError ? undefined : tool.diff,
			})
		}
	}

	return entries
}

export class Agent {
	private options: AgentOptions
	private client: LLMClient
	private systemPrompt: string
	private messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
	private transcript: SessionTranscriptEntry[] = []
	private transcriptReasoning = ""
	private transcriptText = ""
	private todos = ""
	private firstMessageSent = false
	private sessionApproveEdits: boolean
	private sessionApproveCommands = false
	private abortController?: AbortController
	private totalCost = 0
	/**
	 * Latest context window usage (input + output tokens from the most recent
	 * `usage` chunk). Mirrors `totalCost` so the status bar can show it across
	 * /resume, /clear and process restarts.
	 */
	private contextTokens = 0
	private title = ""
	private createdAt = new Date().toISOString()
	private readonly hooks: HookRunner
	/** MCP server manager (may be undefined when MCP is disabled). */
	private mcp?: McpManager
	/** SessionStart fires once, lazily, before the first turn of this instance. */
	private sessionStarted = false
	/** carries SessionStart additionalContext into the first user message */
	private pendingStartContext = ""
	/** guards Stop-hook forced continuation against infinite loops */
	private stopHookActive = false
	/** in-flight fire-and-forget hook promises (Notification), awaited on exit */
	private readonly pendingBackground = new Set<Promise<unknown>>()
	readonly taskId: string

	constructor(options: AgentOptions) {
		this.transcript = options.resume?.transcript
			? options.resume.transcript.map((entry) => ({ ...entry }))
			: legacyTranscript(options.resume?.messages ?? [])
		const onEvent = options.callbacks.onEvent
		this.options = {
			...options,
			callbacks: {
				...options.callbacks,
				onEvent: (event) => {
					this.recordTranscriptEvent(event)
					onEvent(event)
				},
			},
		}
		this.taskId = options.resume?.id ?? randomUUID()
		this.hooks = new HookRunner({
			cwd: options.cwd,
			sessionId: this.taskId,
			transcriptPath: getSessionFilePath(this.taskId),
			config: options.hooks,
			onSystemMessage: (message, isError) =>
				this.options.callbacks.onEvent({ type: "system", message, isError }),
			getSignal: () => this.abortController?.signal,
		})
		if (options.resume) {
			this.messages = options.resume.messages
			this.todos = options.resume.todos
			this.totalCost = options.resume.totalCost
			this.contextTokens = options.resume.contextTokens
			this.title = options.resume.title
			this.createdAt = options.resume.createdAt
			this.firstMessageSent = this.messages.length > 0
		}
		this.sessionApproveEdits = options.autoApproveEdits
		this.mcp = options.mcp
		// Build the system prompt with AGENTS.md memory files and the skills
		// catalog injected, so the model sees project/user instructions and
		// knows which skills it can invoke. An explicit override (from
		// `orbcode -s <text>`) bypasses the default entirely.
		const memoryFiles = options.systemPromptOverride ? [] : loadMemoryFiles(options.cwd)
		const skills = options.systemPromptOverride ? new Map() : loadSkills(options.cwd)
		this.systemPrompt = options.systemPromptOverride
			? options.systemPromptOverride
			: buildSystemPrompt(options.cwd, { memoryFiles, skills })
		this.client = createLLMClient({
			token: options.token,
			modelId: options.modelId,
			taskId: this.taskId,
			organizationId: options.organizationId,
			repo: detectRepo(options.cwd),
			baseUrl: options.baseUrl,
		})
	}

	setModel(modelId: string): void {
		this.options.modelId = modelId
		this.client = createLLMClient({
			token: this.options.token,
			modelId,
			taskId: this.taskId,
			organizationId: this.options.organizationId,
			repo: detectRepo(this.options.cwd),
			baseUrl: this.options.baseUrl,
		})
	}

	get modelId(): string {
		return this.options.modelId
	}

	/**
	 * Latest context window usage in tokens. Falls back to 0 for fresh
	 * sessions; equals the persisted value after a resume so the TUI can
	 * repopulate its `contextTokens` state without waiting for the next
	 * streaming chunk.
	 */
	get lastContextTokens(): number {
		return this.contextTokens
	}

	/** Visible history restored by the TUI, including reasoning and tools. */
	get displayTranscript(): SessionTranscriptEntry[] {
		return this.transcript.map((entry) => ({ ...entry }))
	}

	private recordTranscriptEvent(event: AgentEvent): void {
		switch (event.type) {
			case "reasoning-delta":
				this.transcriptReasoning += event.text
				break
			case "reasoning-done":
				if (this.transcriptReasoning) {
					this.transcript.push({
						kind: "reasoning",
						text: this.transcriptReasoning,
						durationMs: event.durationMs,
					})
				}
				this.transcriptReasoning = ""
				break
			case "text-delta":
				this.transcriptText += event.text
				break
			case "text-done":
				if (this.transcriptText) {
					this.transcript.push({ kind: "assistant", text: this.transcriptText })
				}
				this.transcriptText = ""
				break
			case "stream-reset":
				this.transcriptReasoning = ""
				this.transcriptText = ""
				break
			case "tool-end":
				this.transcript.push({
					kind: "tool",
					name: event.name,
					summary: event.summary,
					resultPreview: event.resultPreview,
					isError: event.isError,
					diff: event.diff,
				})
				break
			case "completion":
				this.transcript.push({ kind: "completion", text: event.result })
				break
			case "system":
				this.transcript.push({
					kind: event.isError ? "error" : "info",
					text: event.message,
				})
				break
			case "error":
				this.transcript.push({ kind: "error", text: event.message })
				break
			case "turn-end":
				if (this.transcriptText) {
					this.transcript.push({ kind: "assistant", text: this.transcriptText })
					this.transcriptText = ""
				}
				if (this.transcriptReasoning) {
					this.transcript.push({
						kind: "reasoning",
						text: this.transcriptReasoning,
						durationMs: 0,
					})
					this.transcriptReasoning = ""
				}
				break
		}
	}

	/** Replace the prompt-derived title with the backend-generated one. */
	setTitle(title: string): void {
		this.title = title
		this.persist()
	}

	/** Swap the hook config mid-session (e.g. after the user trusts project hooks). */
	setHooks(hooks: HooksConfig | undefined): void {
		this.options.hooks = hooks
		this.hooks.setConfig(hooks)
	}

	/** Update auto-approval behavior mid-session (shift+tab cycling in the TUI). */
	setApprovalMode(autoApproveEdits: boolean, autoApproveSafeCommands: boolean): void {
		this.sessionApproveEdits = autoApproveEdits
		this.options.autoApproveEdits = autoApproveEdits
		this.options.autoApproveSafeCommands = autoApproveSafeCommands
		if (!autoApproveSafeCommands) this.sessionApproveCommands = false
	}

	clear(): void {
		this.messages = []
		this.transcript = []
		this.transcriptReasoning = ""
		this.transcriptText = ""
		this.todos = ""
		this.firstMessageSent = false
		this.totalCost = 0
		this.contextTokens = 0
		this.title = ""
		this.pendingStartContext = ""
		this.sessionStarted = false
		this.stopHookActive = false
	}

	/** Write the current conversation to the sessions directory. */
	private persist(): void {
		if (this.messages.length === 0) return
		try {
			saveSession({
				id: this.taskId,
				cwd: this.options.cwd,
				model: this.options.modelId,
				title: this.title,
				createdAt: this.createdAt,
				updatedAt: new Date().toISOString(),
				totalCost: this.totalCost,
				contextTokens: this.contextTokens,
				todos: this.todos,
				messages: this.messages,
				transcript: this.transcript,
			})
		} catch {
			// persistence is best-effort; never break the session over it
		}
	}

	abort(): void {
		this.abortController?.abort()
	}

	get isIdle(): boolean {
		return this.abortController === undefined
	}

	private buildEnvironmentDetails(): string {
		const files = walkFiles(this.options.cwd, true, 200)
		const git = getGitSummary(this.options.cwd)
		const now = new Date()
		const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
		const timeZoneOffset = -now.getTimezoneOffset() / 60
		const timeZoneOffsetHours = Math.floor(Math.abs(timeZoneOffset))
		const timeZoneOffsetMinutes = Math.abs(Math.round((Math.abs(timeZoneOffset) - timeZoneOffsetHours) * 60))
		const timeZoneOffsetStr = `${timeZoneOffset >= 0 ? "+" : "-"}${timeZoneOffsetHours}:${timeZoneOffsetMinutes.toString().padStart(2, "0")}`
		const linkedRepos = renderLinkedReposSection(this.options.cwd)
		return `# Environment Details

## Current Workspace Directory (${this.options.cwd}) Files
${files.join("\n") || "(empty directory)"}
${files.length >= 200 ? "\n(File list truncated.)" : ""}

${git}
${linkedRepos ? `\n${linkedRepos}` : ""}
## Current Time
Current time in ISO 8601 UTC format: ${now.toISOString()}
User time zone: ${timeZone}, UTC${timeZoneOffsetStr}`
	}

	/** Conversation history with internal markers stripped, ready for the model. */
	private outgoingMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
		return this.messages.map((message) =>
			message.role === "user" && typeof message.content === "string"
				? { ...message, content: stripUserQueryTags(message.content) }
				: message,
		)
	}

	private toolContext(): ToolContext {
		return {
			cwd: this.options.cwd,
			token: this.options.token,
			getTodos: () => this.todos,
			setTodos: (todos: string) => {
				this.todos = todos
				this.options.callbacks.onEvent({ type: "todos", todos })
			},
		}
	}

	async runTurn(userText: string): Promise<void> {
		const { onEvent } = this.options.callbacks
		this.abortController = new AbortController()
		this.transcript.push({ kind: "user", text: userText })

		await this.maybeFireSessionStart()

		// UserPromptSubmit may block the prompt outright or attach extra context.
		let promptContext = ""
		if (this.hooks.hasHooks("UserPromptSubmit")) {
			const result = await this.hooks.run("UserPromptSubmit", { prompt: userText })
			if (result.blocked || result.stopAll) {
				const reason = result.blockReason || result.stopReason || "Prompt blocked by a hook."
				onEvent({ type: "system", message: reason, isError: true })
				this.abortController = undefined
				onEvent({ type: "turn-end" })
				return
			}
			if (result.additionalContext) promptContext = result.additionalContext
		}

		if (!this.title) {
			this.title = userText.replace(/\s+/g, " ").trim().slice(0, 80)
		}

		let userContent = `<user_query>\n${userText}\n</user_query>`
		if (!this.firstMessageSent) {
			userContent = `${this.buildEnvironmentDetails()}\n\n${userContent}`
			this.firstMessageSent = true
		}
		// SessionStart context sits above the prompt; UserPromptSubmit context
		// is appended after it. Both reach the model but neither is shown as
		// user-typed text (they live outside the <user_query> markers).
		if (this.pendingStartContext) {
			userContent = `${wrapHookContext("SessionStart", this.pendingStartContext)}\n\n${userContent}`
			this.pendingStartContext = ""
		}
		if (promptContext) {
			userContent = `${userContent}\n\n${wrapHookContext("UserPromptSubmit", promptContext)}`
		}
		this.messages.push({ role: "user", content: userContent })

		try {
			this.stopHookActive = false
			for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
				const done = await this.runStep()
				if (!done) continue
				// The model is ready to stop; Stop hooks may force it to continue.
				if (await this.shouldContinueAfterStop()) continue
				break
			}
		} catch (error) {
			if ((error as Error).name === "AbortError" || this.abortController.signal.aborted) {
				onEvent({ type: "error", message: "Interrupted." })
				// Keep the conversation consistent: note the interruption for the model.
				this.messages.push({
					role: "user",
					content: "System reminder: The user interrupted this response before it finished.",
				})
			} else {
				onEvent({ type: "error", message: (error as Error).message })
			}
		} finally {
			this.abortController = undefined
			this.recordTranscriptEvent({ type: "turn-end" })
			this.persist()
			onEvent({ type: "turn-end" })
		}
	}

	/** Fire SessionStart once per instance, stashing any injected context for
	 *  the first user message. */
	private async maybeFireSessionStart(): Promise<void> {
		if (this.sessionStarted) return
		this.sessionStarted = true
		if (!this.hooks.hasHooks("SessionStart")) return
		const result = await this.hooks.run("SessionStart", {
			source: this.options.resume ? "resume" : "startup",
		})
		if (result.additionalContext) this.pendingStartContext = result.additionalContext
	}

	/** Ask Stop hooks whether the turn should keep going. Forces at most one
	 *  continuation per turn (stop_hook_active) so a hook can't loop forever. */
	private async shouldContinueAfterStop(): Promise<boolean> {
		if (!this.hooks.hasHooks("Stop")) return false
		const result = await this.hooks.run("Stop", { stop_hook_active: this.stopHookActive })
		if (result.stopAll) return false
		if (result.blocked && !this.stopHookActive) {
			this.stopHookActive = true
			const reason = result.blockReason || "A Stop hook asked you to keep going."
			this.messages.push({ role: "user", content: `System reminder (Stop hook): ${reason}` })
			return true
		}
		return false
	}

	/** Track a fire-and-forget hook promise so it can be awaited on exit. */
	private trackBackground(p: Promise<unknown>): void {
		this.pendingBackground.add(p)
		p.finally(() => this.pendingBackground.delete(p))
	}

	/** Wait (up to `timeoutMs`) for in-flight background hooks to settle. */
	private async awaitBackground(timeoutMs: number): Promise<void> {
		if (this.pendingBackground.size === 0) return
		const all = Promise.allSettled([...this.pendingBackground])
		const cap = new Promise<void>((resolve) => {
			const t = setTimeout(resolve, timeoutMs)
			t.unref?.()
		})
		await Promise.race([all, cap])
	}

	/** Fire SessionEnd hooks. Best-effort; never blocks shutdown. */
	async endSession(reason: string): Promise<void> {
		// Let in-flight Notification hooks settle before the final SessionEnd.
		await this.awaitBackground(3000)
		if (this.hooks.hasHooks("SessionEnd")) {
			try {
				await this.hooks.run("SessionEnd", { reason })
			} catch {
				// a SessionEnd hook must never prevent the app from exiting
			}
		}
		// Tear down MCP server connections so child processes / sockets don't leak.
		try {
			await this.mcp?.stop()
		} catch {
			// best-effort
		}
	}

	/** The MCP manager (for the TUI's /mcp command and approval flow). */
	get mcpManager(): McpManager | undefined {
		return this.mcp
	}

	/** Summarize the conversation so far and replace history with the summary. */
	async compact(): Promise<void> {
		const { onEvent } = this.options.callbacks
		if (this.messages.length === 0) {
			onEvent({ type: "error", message: "Nothing to compact yet." })
			onEvent({ type: "turn-end" })
			return
		}
		// Covers the resume-then-immediately-/compact path, so SessionStart
		// always fires before any SessionEnd.
		await this.maybeFireSessionStart()
		// If SessionStart produced context, fold it into the compaction request
		// rather than letting it linger for the next turn.
		let startContext = ""
		if (this.pendingStartContext) {
			startContext = wrapHookContext("SessionStart", this.pendingStartContext) + "\n\n"
			this.pendingStartContext = ""
		}
		// PreCompact runs before summarizing (it cannot cancel compaction).
		if (this.hooks.hasHooks("PreCompact")) {
			await this.hooks.run("PreCompact", { trigger: "manual", custom_instructions: "" })
		}
		this.abortController = new AbortController()
		const signal = this.abortController.signal
		try {
			const request: OpenAI.Chat.ChatCompletionMessageParam[] = [
				...this.outgoingMessages(),
				{
					role: "user",
					content:
						startContext +
							"Summarize this conversation so it can replace the full history. Capture the user's goals, decisions made, files created or modified (with paths), important code details, and any remaining next steps. Be thorough but concise. Respond with only the summary.",
				},
			]
			let summary = ""
			for await (const chunk of this.streamWithRetry(
				() => this.client.createMessage(this.systemPrompt, request, [], signal),
				signal,
				() => {
					// Compaction only streams text (committed once at the end), so a
					// mid-stream retry just discards the partial summary.
					summary = ""
					onEvent({ type: "stream-reset" })
					return true
				},
			)) {
				if (signal.aborted) throw new DOMException("aborted", "AbortError")
				if (chunk.type === "text") {
					summary += chunk.text
					onEvent({ type: "text-delta", text: chunk.text })
				} else if (chunk.type === "usage") {
					this.totalCost += chunk.totalCost ?? 0
					this.contextTokens = (chunk.inputTokens ?? 0) + (chunk.outputTokens ?? 0)
					onEvent({
						type: "usage",
						inputTokens: chunk.inputTokens,
						outputTokens: chunk.outputTokens,
						cost: chunk.totalCost ?? 0,
						totalCost: this.totalCost,
					})
				}
			}
			if (summary) {
				onEvent({ type: "text-done" })
				this.messages = [
					{
						role: "user",
						content: `# Conversation Summary\n\nThe conversation history was compacted. Summary of everything so far:\n\n${summary}`,
					},
				]
			} else {
				onEvent({ type: "error", message: "Compaction produced no summary; history left unchanged." })
			}
		} catch (error) {
			if ((error as Error).name === "AbortError" || signal.aborted) {
				onEvent({ type: "error", message: "Compaction interrupted; history left unchanged." })
			} else {
				onEvent({ type: "error", message: (error as Error).message })
			}
		} finally {
			this.abortController = undefined
			this.recordTranscriptEvent({ type: "turn-end" })
			this.persist()
			onEvent({ type: "turn-end" })
		}
	}

	/**
	 * Consume a model stream, automatically re-establishing the request up to
	 * MAX_STREAM_RETRIES times on a transient/connection failure. A user abort is
	 * never retried.
	 *
	 * Before the first chunk of an attempt nothing has streamed, so the retry is
	 * always clean. Once chunks have streamed, retrying would duplicate on-screen
	 * output — so we only retry mid-stream when the caller supplies `onRestart` and
	 * it returns true, meaning it rolled the partial output back (cleared buffers,
	 * reset accumulators). If it can't (e.g. a row was already committed), the error
	 * propagates.
	 */
	private async *streamWithRetry(
		makeStream: () => ReturnType<LLMClient["createMessage"]>,
		signal: AbortSignal,
		onRestart?: () => boolean,
	): ReturnType<LLMClient["createMessage"]> {
		for (let attempt = 0; ; attempt++) {
			let produced = false
			try {
				for await (const chunk of makeStream()) {
					produced = true
					yield chunk
				}
				return
			} catch (error) {
				if (signal.aborted || (error as Error).name === "AbortError") throw error
				if (attempt >= MAX_STREAM_RETRIES || !isRetryableStreamError(error)) throw error
				// Output already streamed this attempt: only retry if the caller can
				// cleanly roll it back, otherwise a restart would duplicate it.
				if (produced && !(onRestart?.() ?? false)) throw error
				const delayMs = retryBackoffMs(attempt)
				this.options.callbacks.onEvent({
					type: "system",
					message: `Connection to the model failed (${(error as Error).message}). Retrying ${attempt + 1}/${MAX_STREAM_RETRIES} in ${Math.ceil(delayMs / 1000)}s…`,
					isError: false,
				})
				await interruptibleDelay(delayMs, signal)
			}
		}
	}

	/** Run one model request + tool execution round. Returns true when the turn is over. */
	private async runStep(): Promise<boolean> {
		const { onEvent } = this.options.callbacks
		const signal = this.abortController!.signal

		let assistantText = ""
		// A reasoning segment is "open" from its first delta until visible content
		// (text or a tool call) begins. We emit reasoning-done at that transition so
		// "Thought for Ns" reflects only the thinking time — not the answer that
		// follows — and the live "Thinking" block stops before the answer streams.
		// A fresh segment can re-open if the model interleaves reasoning with content.
		let reasoningOpen = false
		let reasoningStart = 0
		let reasoningDetails: unknown
		// Once a reasoning-done row is committed to the transcript we can't roll it
		// back, so a mid-stream retry after that point isn't clean.
		let reasoningRowCommitted = false
		const finalizeReasoning = () => {
			if (reasoningOpen) {
				reasoningOpen = false
				reasoningRowCommitted = true
				onEvent({ type: "reasoning-done", durationMs: Date.now() - reasoningStart })
			}
		}
		const toolCallsByIndex = new Map<number, PendingToolCall>()
		let nextSyntheticIndex = 10000

		// Roll back this step's partial output so streamWithRetry can restart a
		// dropped stream mid-flight. Tools only run after the stream completes, so
		// nothing irreversible has happened yet; the one thing we can't undo is an
		// already-committed reasoning row, so we decline the restart in that case.
		const rollbackForRetry = (): boolean => {
			if (reasoningRowCommitted) return false
			assistantText = ""
			reasoningOpen = false
			reasoningStart = 0
			reasoningDetails = undefined
			toolCallsByIndex.clear()
			nextSyntheticIndex = 10000
			onEvent({ type: "stream-reset" })
			return true
		}

		const stream = this.streamWithRetry(
			() => this.client.createMessage(this.systemPrompt, this.outgoingMessages(), getActiveTools(this.mcp), signal),
			signal,
			rollbackForRetry,
		)

		for await (const chunk of stream) {
			if (signal.aborted) throw new DOMException("aborted", "AbortError")
			switch (chunk.type) {
				case "text":
					// Visible content begins — the reasoning phase (if any) is over.
					finalizeReasoning()
					assistantText += chunk.text
					onEvent({ type: "text-delta", text: chunk.text })
					break
				case "reasoning":
					if (!reasoningOpen) {
						reasoningOpen = true
						reasoningStart = Date.now()
					}
					onEvent({ type: "reasoning-delta", text: chunk.text })
					break
				case "reasoning_details":
					// Opaque thinking blocks (with signatures) for next-turn replay.
					reasoningDetails = chunk.details
					break
				case "native_tool_calls":
					// A tool call also ends the reasoning phase.
					finalizeReasoning()
					for (const tc of chunk.toolCalls) {
						const index = tc.index ?? nextSyntheticIndex++
						let pending = toolCallsByIndex.get(index)
						if (!pending) {
							pending = { id: tc.id || `call_${index}_${Date.now()}`, name: "", arguments: "" }
							toolCallsByIndex.set(index, pending)
						}
						if (tc.id) pending.id = tc.id
						if (tc.function?.name) pending.name = tc.function.name
						if (tc.function?.arguments) pending.arguments += tc.function.arguments
					}
					break
				case "usage":
					this.totalCost += chunk.totalCost ?? 0
					this.contextTokens = (chunk.inputTokens ?? 0) + (chunk.outputTokens ?? 0)
					onEvent({
						type: "usage",
						inputTokens: chunk.inputTokens,
						outputTokens: chunk.outputTokens,
						cost: chunk.totalCost ?? 0,
						totalCost: this.totalCost,
					})
					break
			}
		}

		// A reasoning-only turn (no following text/tool content) still needs closing.
		finalizeReasoning()
		if (assistantText) {
			onEvent({ type: "text-done" })
		}

		const toolCalls = [...toolCallsByIndex.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc)

		const assistantMessage: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
			role: "assistant",
			content: assistantText || null,
		}
		if (toolCalls.length > 0) {
			assistantMessage.tool_calls = toolCalls.map((tc) => ({
				id: tc.id,
				type: "function" as const,
				function: { name: tc.name, arguments: tc.arguments || "{}" },
			}))
		}
		// Stash reasoning blocks (opaque) so the next turn can replay them. The
		// field is persisted with the session and stripped on the OpenAI path.
		if (reasoningDetails !== undefined) {
			;(assistantMessage as unknown as Record<string, unknown>)[REASONING_DETAILS_FIELD] = reasoningDetails
		}
		this.messages.push(assistantMessage)

		if (toolCalls.length === 0) {
			return true
		}

		let completed = false
		for (const toolCall of toolCalls) {
			const resultText = await this.handleToolCall(toolCall)
			this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText })
			if (toolCall.name === "attempt_completion") {
				completed = true
			}
		}
		return completed
	}

	private async handleToolCall(toolCall: PendingToolCall): Promise<string> {
		const { onEvent, requestApproval, requestFollowup } = this.options.callbacks

		let args: Record<string, unknown>
		try {
			args = toolCall.arguments ? JSON.parse(toolCall.arguments) : {}
		} catch (error) {
			const message = `Invalid JSON arguments for ${toolCall.name}: ${(error as Error).message}`
			onEvent({
				type: "tool-end",
				id: toolCall.id,
				name: toolCall.name,
				summary: toolCall.name,
				resultPreview: message,
				isError: true,
			})
			return message
		}

		if (toolCall.name === "attempt_completion") {
			onEvent({ type: "completion", result: String(args.result ?? "") })
			return "The user has been shown the completion result."
		}

		if (toolCall.name === "ask_followup_question") {
			const question = String(args.question ?? "")
			const suggestions = (Array.isArray(args.follow_up) ? args.follow_up : [])
				.map((s: { text?: string }) => ({ text: String(s?.text ?? "") }))
				.filter((s: { text: string }) => s.text)
			// Notification fires whenever OrbCode pauses to wait on the user.
			if (this.hooks.hasHooks("Notification")) {
				this.trackBackground(this.hooks.run("Notification", {
					message: question || "OrbCode is asking a follow-up question.",
				}))
			}
			const answer = await requestFollowup(question, suggestions)
			this.transcript.push({ kind: "user", text: answer })
			return `<answer>\n${answer}\n</answer>`
		}

		// PreToolUse runs before approval/execution. It can block the call,
		// override the approval decision, rewrite the tool input, or add context.
		let preContext = ""
		let bypassApproval = false
		let forceApproval = false
		if (this.hooks.hasHooks("PreToolUse")) {
			const pre = await this.hooks.run("PreToolUse", { tool_name: toolCall.name, tool_input: args })
			if (pre.stopAll || pre.blocked || pre.permissionDecision === "deny") {
				const reason =
					pre.blockReason || pre.stopReason || pre.permissionReason || "Blocked by a PreToolUse hook."
				const blockedSummary = describeToolCall(toolCall.name, args)
				onEvent({ type: "tool-start", id: toolCall.id, name: toolCall.name, summary: blockedSummary })
				onEvent({
					type: "tool-end",
					id: toolCall.id,
					name: toolCall.name,
					summary: blockedSummary,
					resultPreview: reason,
					isError: true,
				})
				if (pre.stopAll) this.abortController?.abort()
				return reason
			}
			if (pre.updatedInput) {
				args = pre.updatedInput
				onEvent({
					type: "system",
					message: `PreToolUse hook rewrote the input for ${toolCall.name}.`,
					isError: false,
				})
			}
			if (pre.permissionDecision === "allow") bypassApproval = true
			if (pre.permissionDecision === "ask") forceApproval = true
			if (pre.additionalContext) preContext = pre.additionalContext
		}

		const summary = describeToolCall(toolCall.name, args)
		onEvent({ type: "tool-start", id: toolCall.id, name: toolCall.name, summary })

		const approvalKind = getApprovalKind(toolCall.name, args)
		const diff = approvalKind === "edit" ? previewFileChange(toolCall.name, args, this.options.cwd) : undefined
		const isDangerous = toolCall.name === "execute_command" && Boolean(args.isDangerous)
		let needsApproval = false
		if (approvalKind === "edit" && !this.sessionApproveEdits) needsApproval = true
		if (approvalKind === "command") {
			needsApproval = isDangerous || !(this.sessionApproveCommands || this.options.autoApproveSafeCommands)
		}
		// A PreToolUse hook can force the approval prompt ("ask") or skip it ("allow").
		if (forceApproval) needsApproval = true
		else if (bypassApproval) needsApproval = false

		if (needsApproval) {
			// Notification fires when OrbCode needs the user to grant permission.
			if (this.hooks.hasHooks("Notification")) {
				this.trackBackground(this.hooks.run("Notification", {
					message: `OrbCode needs your permission to use ${toolCall.name}`,
				}))
			}
			const decision: ApprovalDecision = await requestApproval({
				kind: approvalKind,
				toolName: toolCall.name,
				summary,
				detail: approvalKind === "command" ? String(args.command ?? "") : summary,
				diff,
				isDangerous,
			})
			if (decision === "no") {
				const message = "The user denied this operation."
				onEvent({
					type: "tool-end",
					id: toolCall.id,
					name: toolCall.name,
					summary,
					resultPreview: "Denied by user",
					isError: true,
				})
				return message
			}
			if (decision === "always") {
				if (approvalKind === "edit") this.sessionApproveEdits = true
				if (approvalKind === "command" && !isDangerous) this.sessionApproveCommands = true
			}
		}

		// Yield so the UI can paint the "Working" indicator before a
		// potentially long synchronous tool call blocks the event loop.
		await new Promise(resolve => setImmediate(resolve))
		const result = await executeTool(toolCall.name, args, this.toolContext(), this.mcp)

		// PostToolUse can feed extra context (or a block reason) back to the
		// model. PreToolUse additionalContext is delivered here too.
		let resultText = result.text
		const extras: string[] = []
		if (preContext) extras.push(wrapHookContext("PreToolUse", preContext))
		if (this.hooks.hasHooks("PostToolUse")) {
			const post = await this.hooks.run("PostToolUse", {
				tool_name: toolCall.name,
				tool_input: args,
				tool_response: result.text,
			})
			if (post.additionalContext) extras.push(wrapHookContext("PostToolUse", post.additionalContext))
			if (post.blocked && post.blockReason) extras.push(`[PostToolUse hook]: ${post.blockReason}`)
			if (post.stopAll) {
				this.abortController?.abort()
				onEvent({ type: "system", message: "A PostToolUse hook stopped the turn.", isError: false })
			}
		}
		if (extras.length) resultText += `\n\n${extras.join("\n\n")}`

		const previewLines = resultText.split("\n")
		const resultPreview =
			previewLines.slice(0, RESULT_PREVIEW_LINES).join("\n") +
			(previewLines.length > RESULT_PREVIEW_LINES ? `\n… (${previewLines.length} lines)` : "")

		onEvent({
			type: "tool-end",
			id: toolCall.id,
			name: toolCall.name,
			summary,
			resultPreview,
			isError: Boolean(result.isError),
			diff: result.isError ? undefined : diff,
		})

		return resultText
	}
}
