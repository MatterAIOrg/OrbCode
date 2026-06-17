import { spawn } from "node:child_process"

import { getShell, getShellRunArgs } from "../utils/shell.js"

/**
 * Lifecycle hooks, modeled on Claude Code's hooks feature. Users configure
 * shell commands in settings.json that run at well-defined points in the
 * agent loop. Each command receives a JSON payload on stdin and can influence
 * the agent through its exit code and/or a JSON object printed on stdout.
 *
 * The contract (input field names, output schema, exit-code meanings) matches
 * Claude Code so hook scripts written for it work unchanged here.
 */

/** Every hook event OrbCode knows about, matching Claude Code's event names. */
export const HOOK_EVENTS = [
	"PreToolUse",
	"PostToolUse",
	"Notification",
	"UserPromptSubmit",
	"Stop",
	"SubagentStop",
	"PreCompact",
	"SessionStart",
	"SessionEnd",
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export function isHookEvent(value: string): value is HookEvent {
	return (HOOK_EVENTS as readonly string[]).includes(value)
}

/** A single command hook, as written under a matcher in settings.json. */
export interface HookCommand {
	type: "command"
	command: string
	/** per-command timeout in seconds (default 60) */
	timeout?: number
}

/** A matcher groups command hooks that run when `matcher` matches the event. */
export interface HookMatcher {
	/** regex tested against the event's match field (e.g. the tool name); a
	 *  missing/empty matcher or "*" matches everything */
	matcher?: string
	hooks: HookCommand[]
}

/** The `hooks` block of settings.json: event name → list of matchers. */
export type HooksConfig = Partial<Record<HookEvent, HookMatcher[]>>

/** Shape of a JSON object a hook may print on stdout to control the agent. */
interface HookJsonOutput {
	continue?: boolean
	stopReason?: string
	suppressOutput?: boolean
	systemMessage?: string
	decision?: "approve" | "block"
	reason?: string
	hookSpecificOutput?: {
		hookEventName?: string
		permissionDecision?: "allow" | "deny" | "ask"
		permissionDecisionReason?: string
		updatedInput?: Record<string, unknown>
		additionalContext?: string
	}
}

/** The merged outcome of every matching hook for one event. */
export interface AggregatedHookResult {
	/** the pending action (tool call / prompt / stop) should be blocked */
	blocked: boolean
	/** human/model-facing reason for the block, joined across hooks */
	blockReason?: string
	/** a hook asked to stop the whole turn (`{"continue": false}`) */
	stopAll: boolean
	stopReason?: string
	/** PreToolUse permission override (most restrictive across hooks wins) */
	permissionDecision?: "allow" | "deny" | "ask"
	permissionReason?: string
	/** PreToolUse replacement tool input */
	updatedInput?: Record<string, unknown>
	/** extra context to feed the model (UserPromptSubmit/SessionStart/tool events) */
	additionalContext?: string
}

/** Per-hook interpreted result, folded together by `aggregate`. */
interface PerHookResult {
	blocked?: boolean
	blockReason?: string
	stopAll?: boolean
	stopReason?: string
	permissionDecision?: "allow" | "deny" | "ask"
	permissionReason?: string
	updatedInput?: Record<string, unknown>
	additionalContext?: string
}

export interface HookRunnerContext {
	cwd: string
	sessionId: string
	/** path to the session transcript on disk, passed to hooks as transcript_path */
	transcriptPath: string
	config?: HooksConfig
	/** surface a systemMessage or a non-blocking hook error to the UI */
	onSystemMessage?: (message: string, isError: boolean) => void
	/** lets in-flight hooks be cancelled when the user interrupts the turn */
	getSignal?: () => AbortSignal | undefined
}

const DEFAULT_TIMEOUT_S = 10
const MAX_HOOK_OUTPUT_CHARS = 1_000_000
/** Cap on injected `additionalContext` so a single hook can't blow the model's
 *  context window. ~8 KB ≈ 2k tokens. */
const MAX_CONTEXT_CHARS = 8_000

const EMPTY_RESULT: AggregatedHookResult = { blocked: false, stopAll: false }

export class HookRunner {
	private readonly ctx: HookRunnerContext

	constructor(ctx: HookRunnerContext) {
		this.ctx = ctx
	}

	/** Replace the hook config at runtime (e.g. after the user trusts project
	 *  hooks mid-session). */
	setConfig(config: HooksConfig | undefined): void {
		this.ctx.config = config
	}

	/** True if at least one matcher is configured for `event`. Cheap pre-check
	 *  so the agent can skip building payloads when no hooks exist. */
	hasHooks(event: HookEvent): boolean {
		const matchers = this.ctx.config?.[event]
		return Array.isArray(matchers) && matchers.length > 0
	}

	/**
	 * Run every command hook that matches `event`, in parallel, and fold their
	 * outputs into a single result. `fields` carries the event-specific input
	 * (tool_name, prompt, trigger, …); base fields are added automatically.
	 * Never throws — a misbehaving hook surfaces as a non-blocking message.
	 */
	async run(event: HookEvent, fields: Record<string, unknown> = {}): Promise<AggregatedHookResult> {
		const matchers = this.ctx.config?.[event]
		if (!matchers || matchers.length === 0) return EMPTY_RESULT

		const query = getMatchQuery(event, fields)
		const selected: HookCommand[] = []
		for (const m of matchers) {
			if (!m || !Array.isArray(m.hooks)) continue
			if (!matcherMatches(m.matcher, query)) continue
			for (const h of m.hooks) {
				if (h && h.type === "command" && typeof h.command === "string" && h.command.trim()) {
					selected.push(h)
				}
			}
		}
		if (selected.length === 0) return EMPTY_RESULT

		const input =
			JSON.stringify({
				session_id: this.ctx.sessionId,
				transcript_path: this.ctx.transcriptPath,
				cwd: this.ctx.cwd,
				hook_event_name: event,
				...fields,
			}) + "\n"
		const env = buildHookEnv(this.ctx.cwd)

		const results = await Promise.all(selected.map((h) => this.runOne(event, h, input, env)))
		return aggregate(results)
	}

	private surface(message: string, isError: boolean): void {
		this.ctx.onSystemMessage?.(message, isError)
	}

	private async runOne(
		event: HookEvent,
		hook: HookCommand,
		input: string,
		env: NodeJS.ProcessEnv,
	): Promise<PerHookResult> {
		const timeoutMs = (hook.timeout && hook.timeout > 0 ? hook.timeout : DEFAULT_TIMEOUT_S) * 1000
		let raw: RawHookOutput
		try {
			raw = await execHookCommand(hook.command, input, timeoutMs, this.ctx.cwd, env, this.ctx.getSignal?.())
		} catch (error) {
			this.surface(`Hook failed to start: ${(error as Error).message}`, true)
			return {}
		}

		const { stdout, stderr, code, timedOut } = raw
		if (timedOut) {
			this.surface(`Hook timed out after ${timeoutMs / 1000}s: ${truncate(hook.command, 80)}`, true)
		}

		const { json, plainText } = parseHookOutput(stdout)
		const result: PerHookResult = {}

		if (json) {
			if (json.continue === false) {
				result.stopAll = true
				result.stopReason = json.stopReason
			}
			if (typeof json.systemMessage === "string" && json.systemMessage) {
				this.surface(json.systemMessage, false)
			}
			if (json.decision === "approve") {
				result.permissionDecision = "allow"
			} else if (json.decision === "block") {
				result.blocked = true
				result.blockReason = json.reason || "Blocked by hook"
			}

			const hso = json.hookSpecificOutput
			if (hso && typeof hso === "object") {
				const pd = hso.permissionDecision
				if (hso.hookEventName === "PreToolUse" && pd) {
					if (pd === "allow") {
						result.permissionDecision = "allow"
					} else if (pd === "deny") {
						result.permissionDecision = "deny"
						result.blocked = true
						result.blockReason = hso.permissionDecisionReason || json.reason || "Blocked by hook"
					} else if (pd === "ask") {
						result.permissionDecision = "ask"
					}
				}
				if (typeof hso.permissionDecisionReason === "string") {
					result.permissionReason = hso.permissionDecisionReason
				}
				if (hso.updatedInput && typeof hso.updatedInput === "object") {
					result.updatedInput = hso.updatedInput
				}
				if (typeof hso.additionalContext === "string" && hso.additionalContext) {
					result.additionalContext = hso.additionalContext
				}
			}
		}

		// Exit-code protocol: 2 = blocking error (stderr is the reason fed back to
		// the model / shown to the user); other non-zero = non-blocking error.
		if (code === 2) {
			result.blocked = true
			if (!result.blockReason) result.blockReason = stderr.trim() || "Blocked by hook (exit 2)"
		} else if (code !== 0 && !timedOut) {
			if (stderr.trim()) this.surface(`Hook error (exit ${code}): ${stderr.trim()}`, true)
		}

		// On success, plain (non-JSON) stdout is injected as extra context for the
		// two events Claude Code treats that way.
		if (code === 0 && !json && plainText && plainText.trim()) {
			if (event === "UserPromptSubmit" || event === "SessionStart") {
				result.additionalContext = mergeContext(result.additionalContext, plainText.trim())
			}
		}

		return result
	}
}

/** The event field a matcher's regex is tested against, per Claude Code. */
function getMatchQuery(event: HookEvent, fields: Record<string, unknown>): string | undefined {
	switch (event) {
		case "PreToolUse":
		case "PostToolUse":
			return typeof fields.tool_name === "string" ? fields.tool_name : undefined
		case "PreCompact":
			return typeof fields.trigger === "string" ? fields.trigger : undefined
		case "SessionStart":
			return typeof fields.source === "string" ? fields.source : undefined
		case "SessionEnd":
			return typeof fields.reason === "string" ? fields.reason : undefined
		default:
			return undefined
	}
}

function matcherMatches(matcher: string | undefined, query: string | undefined): boolean {
	if (!matcher || matcher === "*") return true
	if (query === undefined) return false
	try {
		// Auto-anchor so "execute_command" matches exactly that tool name, not
		// "execute_command_extra". Alternation ("a|b") still works because the
		// anchors wrap a non-capturing group: ^(?:a|b)$.
		return new RegExp(`^(?:${matcher})$`).test(query)
	} catch {
		// An invalid regex degrades to an exact-string comparison.
		return matcher === query
	}
}

function parseHookOutput(stdout: string): { json?: HookJsonOutput; plainText?: string } {
	const trimmed = stdout.trim()
	if (!trimmed.startsWith("{")) return { plainText: stdout }
	try {
		const parsed = JSON.parse(trimmed)
		if (parsed && typeof parsed === "object") return { json: parsed as HookJsonOutput }
		return { plainText: stdout }
	} catch {
		return { plainText: stdout }
	}
}

function aggregate(results: PerHookResult[]): AggregatedHookResult {
	const out: AggregatedHookResult = { blocked: false, stopAll: false }
	const contexts: string[] = []
	const blockReasons: string[] = []
	let deny = false
	let ask = false
	let allow = false

	for (const r of results) {
		if (r.stopAll) {
			out.stopAll = true
			if (r.stopReason && !out.stopReason) out.stopReason = r.stopReason
		}
		if (r.blocked) {
			out.blocked = true
			if (r.blockReason) blockReasons.push(r.blockReason)
		}
		if (r.permissionDecision === "deny") deny = true
		else if (r.permissionDecision === "ask") ask = true
		else if (r.permissionDecision === "allow") allow = true
		if (r.permissionReason && !out.permissionReason) out.permissionReason = r.permissionReason
		if (r.updatedInput) out.updatedInput = r.updatedInput // last writer wins
		if (r.additionalContext) contexts.push(r.additionalContext)
	}

	// Most restrictive permission decision wins: deny > ask > allow.
	out.permissionDecision = deny ? "deny" : ask ? "ask" : allow ? "allow" : undefined
	if (blockReasons.length) out.blockReason = blockReasons.join("\n")
	if (contexts.length) out.additionalContext = capContext(contexts.join("\n\n"))
	return out
}

function mergeContext(existing: string | undefined, addition: string): string {
	return existing ? `${existing}\n\n${addition}` : addition
}

/** Cap injected context so a single hook can't blow the model's context window. */
function capContext(text: string): string {
	if (text.length <= MAX_CONTEXT_CHARS) return text
	return text.slice(0, MAX_CONTEXT_CHARS) + "\n[…truncated by OrbCode hook context cap…]"
}

/** Keys always stripped from the hook environment (OrbCode credentials/config). */
const HOOK_ENV_REDACT_EXACT = new Set([
	"MATTERAI_TOKEN",
	"MATTERAI_API_KEY",
	"MATTERAI_CONFIG_DIR",
	"MATTERAI_BACKEND_URL",
	"MATTERAI_APP_URL",
])

/** Pattern for credential-like env var names (TOKEN, KEY, SECRET, …) so
 *  third-party secrets (GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, …) are redacted
 *  too. Matches these as whole words delimited by start/end/underscore. */
const HOOK_ENV_REDACT_PATTERN = /(?:^|_)(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)(?:$|_)/i

/** Build the environment for a hook command. The full parent env is inherited
 *  (so PATH, HOME, npx, git, … all work) minus anything that looks like a
 *  credential — hooks must never see the user's API token. */
function buildHookEnv(cwd: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { MATTERAI_PROJECT_DIR: cwd }
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue
		if (HOOK_ENV_REDACT_EXACT.has(key)) continue
		if (HOOK_ENV_REDACT_PATTERN.test(key)) continue
		env[key] = value
	}
	return env
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim()
	return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…"
}

interface RawHookOutput {
	stdout: string
	stderr: string
	code: number
	timedOut: boolean
}

/** Spawn a hook command, pipe `input` to its stdin, and collect its output. */
function execHookCommand(
	command: string,
	input: string,
	timeoutMs: number,
	cwd: string,
	env: NodeJS.ProcessEnv,
	signal?: AbortSignal,
): Promise<RawHookOutput> {
	return new Promise((resolve) => {
		let settled = false
		let timedOut = false
		let stdout = ""
		let stderr = ""

		const child = spawn(getShell(), getShellRunArgs(command), {
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsVerbatimArguments: process.platform === "win32",
		})

		const onAbort = () => child.kill("SIGTERM")
		let killTimer: ReturnType<typeof setTimeout> | undefined
		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGTERM")
			// Escalate to SIGKILL if SIGTERM is ignored; unref'd so this never
			// keeps the process alive on its own.
			killTimer = setTimeout(() => child.kill("SIGKILL"), 2000)
			killTimer.unref?.()
		}, timeoutMs)
		timer.unref?.()

		const finish = (code: number) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			if (killTimer) clearTimeout(killTimer)
			signal?.removeEventListener("abort", onAbort)
			resolve({ stdout, stderr, code, timedOut })
		}

		child.stdout.setEncoding("utf8")
		child.stderr.setEncoding("utf8")
		child.stdout.on("data", (d: string) => {
			if (stdout.length < MAX_HOOK_OUTPUT_CHARS) stdout += d
		})
		child.stderr.on("data", (d: string) => {
			if (stderr.length < MAX_HOOK_OUTPUT_CHARS) stderr += d
		})

		child.on("error", (error) => {
			stderr += (stderr ? "\n" : "") + (error as Error).message
			finish(1)
		})
		child.on("close", (code) => finish(code ?? (timedOut ? 124 : 0)))

		if (signal) {
			if (signal.aborted) child.kill("SIGTERM")
			else signal.addEventListener("abort", onAbort, { once: true })
		}

		// A hook may not read stdin; ignore EPIPE when it exits before we finish.
		child.stdin.on("error", () => {})
		try {
			child.stdin.write(input)
			child.stdin.end()
		} catch {
			// child already gone; close handler will resolve
		}
	})
}
