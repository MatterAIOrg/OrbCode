import { execSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import type OpenAI from "openai"

import {
	type Attachment,
	attachmentSummary,
	formatAttachmentContext,
} from "../attachments.js"
import {
	foldSystemMessages,
	REASONING_CONTENT_FIELD,
	REASONING_DETAILS_FIELD,
	type LLMClient,
} from "../api/llmClient.js"
import { getModel } from "../api/models.js"
import { createLLMClient } from "../api/provider.js"
import {
	buildContextReminders,
	buildEnvironmentMessage,
	buildSystemPrompt,
	isTokensLeftNote,
	systemReminder,
	tokensLeftNote,
} from "../prompts/system.js"
import {
	describeToolCall,
	disposeSearchFiles,
	executeTool,
	getActiveTools,
	getApprovalKind,
	type ToolContext,
} from "../tools/index.js"
import { previewFileChange } from "../tools/executors/files.js"
import { extractFigmaUrls, figmaFetch } from "../tools/executors/figma.js"
import { stripSearchPageMetadataForDisplay } from "../tools/executors/searchFiles/format.js"
import { isReadOnlyCommand } from "../tools/readOnlyCommand.js"
import type { AgentCallbacks, AgentEvent, ApprovalDecision } from "./events.js"
import {
	getSessionFilePath,
	saveSession,
	type SessionData,
	type SessionTranscriptEntry,
} from "./sessions.js"
import {
	changedFilePaths,
	deleteBackups,
	restoreFiles,
	snapshotFile,
	type Checkpoint,
	type RewindMode,
	type RewindPoint,
	type RewindResult,
} from "./checkpoints.js"
import { HookRunner, type HooksConfig } from "./hooks.js"
import { McpManager } from "../mcp/manager.js"
import { loadMemoryFiles, renderMemorySection } from "../memory/loader.js"
import { loadSkills, renderSkillCatalog } from "../skills/loader.js"
import { renderLinkedReposSection } from "../config/links.js"
import { unifiedDiff } from "../utils/diff.js"
import { parseToolCallArguments } from "../utils/jsonRepair.js"
import { normalizeTodoList } from "../utils/todos.js"
import { takeFinishedBackgroundCommands } from "../tools/executors/backgroundCommands.js"
import {
	countDiffLines,
	detectGitRepo,
	getGitHead,
	getPersistedGitHead,
	getLanguageFromPath,
	observeGitCommits,
	persistGitHead,
	reportLineMetrics,
	reportUsageEvent,
} from "../api/metrics.js"

/**
 * Prompt-cache warmup on launch and /new (see Agent.warmCache). Off until it
 * has had more testing; while off, agents are created lazily on the first
 * message exactly as before.
 */
export const CACHE_WARMUP_ENABLED = false

const MAX_STEPS_PER_TURN = 50
const RESULT_PREVIEW_LINES = 6
/** Maximum number of independent read-only tools started at once. */
const MAX_PARALLEL_READ_ONLY_TOOLS = 4

/** These tools only observe repository state, so a leading run of them in one
 *  assistant response can execute concurrently. Mutating, interactive, and
 *  external tools stay serialized. */
const PARALLEL_READ_ONLY_TOOLS = new Set([
	"read_file",
	"search_files",
	"list_files",
	"list_code_definition_names",
	"codebase_search",
	"lsp",
])
/** How many times to automatically re-establish a model request that fails
 *  before producing any output (transient/connection errors). */
const MAX_STREAM_RETRIES = 3
/** Slack (ms) when comparing the session file's mtime against this process's
 *  last write, so our own just-written file is never mistaken for a foreign
 *  newer write. */
const STALE_WRITE_TOLERANCE_MS = 2000

// --- Context management -----------------------------------------------------
// History is append-only between compactions: rewriting an earlier message
// changes the request prefix and throws away the provider's prompt cache from
// that point on.
/** A size-limited summary request still sends the most recent tool results verbatim. */
const KEEP_RECENT_TOOL_RESULTS = 4
/** Summarize the history before a step once context passes this fraction of the window. */
const AUTO_COMPACT_FRACTION = 0.8
/** Rough chars-per-token for content the gateway hasn't measured yet. */
const CHARS_PER_TOKEN = 4
/** Tokens counted per image part: its base64 length says nothing about its token cost. */
const IMAGE_TOKEN_ESTIMATE = 1500
/** Share of the window the summary request may use, tried in order. The
 *  smaller budgets cover upstreams whose real window is under the catalog's. */
const SUMMARY_BUDGET_FRACTIONS = [0.6, 0.3, 0.15]
/** Warn the model when the same call returns the same output this many times in a row. */
const REPEAT_WARN_AT = 3
/** A successful edit changes the files, so earlier identical calls may now differ. */
const EDIT_TOOLS = new Set(["file_edit", "multi_file_edit", "file_write"])

/** Transient failures worth auto-retrying: any transport/connection error (no
 *  usable HTTP status — socket reset, DNS, timeout, TLS drop) plus 5xx/408/429
 *  server responses. Real 4xx client errors (auth, bad request) are not retried. */
function isRetryableStreamError(error: unknown): boolean {
	// Resending the same oversized request can't succeed; the turn compacts instead.
	if (isContextOverflowError(error)) return false
	const err = error as { status?: number; code?: number | string }
	const status = Number(err?.status ?? err?.code)
	if (Number.isFinite(status) && status !== 0) {
		return status >= 500 || status === 408 || status === 429
	}
	return true
}

/** The provider rejected the request because the conversation doesn't fit its context window. */
function isContextOverflowError(error: unknown): boolean {
	const err = error as {
		status?: number
		statusCode?: number
		code?: unknown
		message?: unknown
		error?: unknown
	}
	const status = Number(err?.status ?? err?.statusCode)
	if (Number.isFinite(status) && status !== 0 && ![400, 413, 422].includes(status)) return false
	let body = ""
	try {
		body = JSON.stringify(err?.error ?? "")
	} catch {
		// unserializable error body — the message alone decides
	}
	const text = `${String(err?.message ?? "")} ${String(err?.code ?? "")} ${body}`
	return /context[ _-]?(length|window|limit)|maximum context|too many (input )?tokens|prompt is too long|input is too long|request too large|exceeds? (the )?(maximum|max|context|token)|reduce the length/i.test(
		text,
	)
}

/** Token estimate for a message the gateway hasn't measured yet. */
function messageTokenEstimate(message: OpenAI.Chat.ChatCompletionMessageParam): number {
	let chars = 0
	let images = 0
	const content = (message as { content?: unknown }).content
	if (typeof content === "string") {
		chars += content.length
	} else if (Array.isArray(content)) {
		for (const part of content as Array<{ type?: string; text?: string }>) {
			if (part?.type === "text") chars += part.text?.length ?? 0
			else if (part?.type === "image_url") images++
		}
	}
	if (message.role === "assistant") {
		for (const call of message.tool_calls ?? []) {
			if (call.type === "function") chars += call.function.name.length + call.function.arguments.length
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN) + images * IMAGE_TOKEN_ESTIMATE
}

/** Cut a message's text down to `maxChars` (structure and tool-call links intact). */
function truncateMessage(
	message: OpenAI.Chat.ChatCompletionMessageParam,
	maxChars: number,
): OpenAI.Chat.ChatCompletionMessageParam {
	const marker = "\n[… truncated to fit the context window …]"
	const content = (message as { content?: unknown }).content
	if (typeof content === "string") {
		return content.length > maxChars
			? ({ ...message, content: content.slice(0, maxChars) + marker } as OpenAI.Chat.ChatCompletionMessageParam)
			: message
	}
	if (Array.isArray(content)) {
		return {
			...message,
			content: (content as Array<{ type?: string; text?: string }>).map((part) =>
				part?.type === "text" && (part.text?.length ?? 0) > maxChars
					? { ...part, text: part.text!.slice(0, maxChars) + marker }
					: part,
			),
		} as OpenAI.Chat.ChatCompletionMessageParam
	}
	return message
}

function retryBackoffMs(attempt: number): number {
	return Math.min(500 * 2 ** attempt, 8000)
}

/** Short, user-facing label for a stream failure. Upstream error bodies can be
 *  raw HTML (e.g. an nginx 502 page), so never surface `error.message` — only
 *  the numeric HTTP status when one is available. */
function streamErrorLabel(error: unknown): string {
	const err = error as { status?: number; code?: number | string }
	const status = Number(err?.status ?? err?.code)
	return Number.isFinite(status) && status !== 0 ? `Connection failed (${status})` : "Connection failed"
}

/** Error message safe to show in the transcript. Upstream gateways often answer
 *  failures with raw HTML pages or huge multi-line bodies; collapse those to a
 *  clean status label instead of dumping markup into the UI. */
function sanitizeErrorMessage(error: unknown): string {
	const err = error as { status?: number; code?: number | string; message?: unknown }
	const message = String(err?.message ?? error ?? "Unknown error")
	const clean = message.replace(/\s+/g, " ").trim()
	const looksLikeHtml = /<\/?[a-z][^>]*>/i.test(clean)
	if (!looksLikeHtml && clean.length <= 200) return clean
	const status = Number(err?.status ?? err?.code)
	return Number.isFinite(status) && status !== 0 ? `Request failed (${status})` : "Request failed"
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
	/** Inject a model client (tests). Defaults to the client for `modelId`. */
	client?: LLMClient
}

interface PendingToolCall {
	id: string
	name: string
	arguments: string
}

/** Read-only tools, plus shell commands that only observe (rg, find, ls, git diff, ...). */
function isParallelReadOnlyCall(toolCall: PendingToolCall): boolean {
	if (PARALLEL_READ_ONLY_TOOLS.has(toolCall.name)) return true
	if (toolCall.name !== "Bash" && toolCall.name !== "execute_command") return false
	try {
		const args = JSON.parse(toolCall.arguments) as { command?: unknown; isDangerous?: unknown }
		return typeof args.command === "string" && !args.isDangerous && isReadOnlyCommand(args.command)
	} catch {
		return false
	}
}

function gitOutput(cwd: string, command: string): string | undefined {
	try {
		return execSync(command, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trimEnd()
	} catch {
		return undefined
	}
}

/** Git snapshot for the first message's context reminder; empty outside a repo. */
function getGitSummary(cwd: string): string {
	const branch = gitOutput(cwd, "git rev-parse --abbrev-ref HEAD")
	if (branch === undefined) return ""
	const mainBranch = gitOutput(cwd, "git symbolic-ref --short refs/remotes/origin/HEAD")?.replace(/^origin\//, "")
	const user = gitOutput(cwd, "git config user.name")
	const status = (gitOutput(cwd, "git status --short") ?? "").split("\n").filter(Boolean)
	const commits = gitOutput(cwd, "git log --oneline -n 5")
	return [
		"# gitStatus",
		"This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
		"",
		`Current branch: ${branch}`,
		...(mainBranch ? ["", `Main branch (you will usually use this for PRs): ${mainBranch}`] : []),
		...(user ? ["", `Git user: ${user}`] : []),
		"",
		"Status:",
		status.length === 0
			? "(clean)"
			: status.slice(0, 20).join("\n") + (status.length > 20 ? `\n… (${status.length - 20} more)` : ""),
		...(commits ? ["", "Recent commits:", commits] : []),
	].join("\n")
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

/** Note appended to a tool result whose arguments needed JSON repair, so the
 * model sees what actually ran instead of repeating the same malformed call. */
function jsonRepairNote(toolName: string, args: Record<string, unknown>): string {
	const interpreted = JSON.stringify(args) ?? "{}"
	const preview = interpreted.length > 500 ? `${interpreted.slice(0, 500)}…` : interpreted
	return `[OrbCode] The ${toolName} arguments were malformed JSON and were auto-repaired before execution. Interpreted arguments: ${preview}. Emit strictly valid JSON in future tool calls — every key and string value must be double-quoted.`
}

/** Completion notes for background commands that finished since the last turn. */
function backgroundCommandsNote(taskId: string): string {
	const finished = takeFinishedBackgroundCommands(taskId)
	if (finished.length === 0) return ""
	const lines = finished.map((cmd) => {
		const outcome =
			cmd.status === "killed"
				? "was stopped"
				: `${cmd.status} (exit ${cmd.exitCode === null ? "unknown" : cmd.exitCode})`
		return `- ${cmd.id}: \`${cmd.command}\` ${outcome}`
	})
	return `<background_commands>\nThese background commands finished since your last turn. Use check_background with the id if you need the output.\n${lines.join("\n")}\n</background_commands>`
}

function formatResultPreview(toolName: string, text: string): string {
	if ((toolName === "Bash" || toolName === "execute_command") && text.startsWith("Background command started")) {
		return "Running in background · ctrl+b to view"
	}
	const visibleText = toolName === "search_files" ? stripSearchPageMetadataForDisplay(text) : text
	if (!visibleText) return ""
	const lines = visibleText.split("\n")
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
				// Repair when possible so old sessions with malformed arguments
				// still produce useful summaries.
				const args = parseToolCallArguments(call.function.arguments)?.args ?? {}
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
				resultPreview: formatResultPreview(tool.name, text),
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
	/** AGENTS.md instructions and skills catalog, sent as conversation context
	 *  (not in the system prompt) so the system prompt stays cacheable. */
	private memorySection = ""
	private skillCatalog = ""
	private messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
	private transcript: SessionTranscriptEntry[] = []
	private transcriptReasoning = ""
	private transcriptText = ""
	/** one rewind point per user turn, oldest first (see /rewind) */
	private checkpoints: Checkpoint[] = []
	private todos = ""
	private firstMessageSent = false
	private sessionApproveEdits: boolean
	private sessionApproveCommands = false
	private abortController?: AbortController
	/** in-flight prompt-cache warmup (see warmCache) */
	private warmupController?: AbortController
	private totalCost = 0
	/**
	 * Latest context window usage (input + output tokens from the most recent
	 * `usage` chunk). Mirrors `totalCost` so the status bar can show it across
	 * /resume, /clear and process restarts.
	 */
	private contextTokens = 0
	private title = ""
	private createdAt = new Date().toISOString()
	private lastGitHead?: string
	/**
	 * mtime (ms) of this instance's last session write, or the resumed file's
	 * mtime at startup. A newer on-disk mtime means another process wrote
	 * newer turns; persist() then refuses to roll the file back.
	 */
	private lastSessionWriteMs = 0
	private readonly hooks: HookRunner
	/** MCP server manager (may be undefined when MCP is disabled). */
	private mcp?: McpManager
	/** SessionStart fires once, lazily, before the first turn of this instance. */
	private sessionStarted = false
	/** carries SessionStart additionalContext into the first user message */
	private pendingStartContext = ""
	/** guards Stop-hook forced continuation against infinite loops */
	private stopHookActive = false
	/** set after a failed auto-compaction so it isn't retried on every step of
	 *  the same turn; cleared at the start of each turn and on any success */
	private autoCompactFailed = false
	/** how many messages the last usage report (`contextTokens`) covered; later
	 *  ones (tool results, new user input) are estimated until the next report */
	private measuredMessages = 0
	/** consecutive identical call+output tracking for loop warnings */
	private readonly repeatTracker = new Map<string, { hash: string; count: number }>()
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
		this.lastGitHead =
			options.resume?.lastGitHead ??
			getPersistedGitHead(options.cwd) ??
			getGitHead(options.cwd)
		persistGitHead(options.cwd, this.lastGitHead)
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
			this.checkpoints = (options.resume.checkpoints ?? []).map((checkpoint) => ({
				...checkpoint,
				files: checkpoint.files.map((file) => ({ ...file })),
			}))
			this.todos = normalizeTodoList(options.resume.todos)
			this.totalCost = options.resume.totalCost
			this.contextTokens = options.resume.contextTokens
			// Sessions without a recorded size are estimated from their messages.
			this.measuredMessages = this.contextTokens > 0 ? this.messages.length : 0
			this.title = options.resume.title
			this.createdAt = options.resume.createdAt
			this.firstMessageSent = this.messages.length > 0
			// Baseline for the stale-write guard: the resumed file's mtime.
			try {
				this.lastSessionWriteMs = fs.statSync(getSessionFilePath(this.taskId)).mtimeMs
			} catch {
				// file missing — nothing to protect yet
			}
		}
		this.sessionApproveEdits = options.autoApproveEdits
		this.mcp = options.mcp
		// AGENTS.md instructions and the skills catalog reach the model with the
		// first message (see contextReminders / environmentMessage). An explicit
		// override (from `orbcode -s <text>`) bypasses them and the default prompt.
		if (!options.systemPromptOverride) {
			this.memorySection = renderMemorySection(loadMemoryFiles(options.cwd))
			this.skillCatalog = renderSkillCatalog(loadSkills(options.cwd))
		}
		this.systemPrompt = options.systemPromptOverride ?? buildSystemPrompt()
		this.client =
			options.client ??
			createLLMClient({
				token: options.token,
				modelId: options.modelId,
				taskId: this.taskId,
				organizationId: options.organizationId,
				repo: detectGitRepo(options.cwd),
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
			repo: detectGitRepo(this.options.cwd),
			baseUrl: this.options.baseUrl,
		})
	}

	/**
	 * Prime the gateway's prompt cache for this task before the user's first
	 * message: same taskId (provider session affinity), system prompt and tools
	 * as the first real turn, one output token. Only for a fresh conversation;
	 * best-effort and silent, since a miss just means a normal cold start.
	 */
	async warmCache(): Promise<void> {
		if (this.messages.length > 0 || !this.client.warmup) return
		this.warmupController?.abort()
		const controller = new AbortController()
		this.warmupController = controller
		try {
			await this.mcp?.whenStarted()
			if (controller.signal.aborted || this.messages.length > 0) return
			await this.client.warmup(this.systemPrompt, getActiveTools(this.mcp), controller.signal)
		} catch {
			// ignore — warmup is an optimization only
		} finally {
			if (this.warmupController === controller) this.warmupController = undefined
		}
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
		return this.transcript.map((entry) =>
			entry.kind === "tool" && entry.name === "search_files"
				? { ...entry, resultPreview: stripSearchPageMetadataForDisplay(entry.resultPreview) }
				: { ...entry },
		)
	}

	/** User turns the conversation can be rewound to, oldest first. */
	get rewindPoints(): RewindPoint[] {
		return this.checkpoints.map((checkpoint, index) => ({
			id: checkpoint.id,
			text: checkpoint.text,
			attachments: checkpoint.attachments,
			changedFiles: changedFilePaths(this.checkpoints.slice(index)),
		}))
	}

	/**
	 * Rewind to just before the user turn `id`: drop that turn and everything
	 * after it from the conversation, restore the files the agent changed since,
	 * or both. Returns the original prompt so the caller can offer it for editing.
	 */
	rewind(id: string, mode: RewindMode): RewindResult {
		if (!this.isIdle) throw new Error("Can't rewind while a response is running.")
		const index = this.checkpoints.findIndex((checkpoint) => checkpoint.id === id)
		if (index === -1) throw new Error("That message can no longer be rewound to.")
		const target = this.checkpoints[index]
		const affected = this.checkpoints.slice(index)

		const { restored, failed } =
			mode === "conversation" ? { restored: [], failed: [] } : restoreFiles(this.taskId, affected)
		const result: RewindResult = {
			text: target.text,
			attachments: target.attachments,
			todos: normalizeTodoList(target.todos),
			restoredFiles: restored,
			failedFiles: failed,
		}

		if (mode === "code") {
			// The files are back at the start of `target`; snapshots taken after
			// that point describe a timeline that no longer exists.
			deleteBackups(this.taskId, affected)
			for (const checkpoint of affected) checkpoint.files = []
			if (restored.length > 0) {
				this.messages.push({
					role: "user",
					content: systemReminder(
						`The user restored these files to an earlier state, so any edits you made to them since are gone:\n${restored.join("\n")}`,
					),
				})
			}
			this.persist()
			return result
		}

		const previous = this.checkpoints[index - 1]
		if (mode === "both") {
			deleteBackups(this.taskId, affected)
		} else if (previous) {
			// Files stay as they are, so a later code rewind to an earlier turn
			// must still be able to undo the edits made in the dropped turns.
			for (const checkpoint of affected) {
				for (const file of checkpoint.files) {
					if (!previous.files.some((known) => known.path === file.path)) previous.files.push(file)
				}
			}
		}
		this.checkpoints = this.checkpoints.slice(0, index)
		this.messages = this.messages.slice(0, target.messageIndex)
		this.transcript = this.transcript.slice(0, target.transcriptIndex)
		this.transcriptReasoning = ""
		this.transcriptText = ""
		this.todos = normalizeTodoList(target.todos)
		this.firstMessageSent = this.messages.length > 0
		if (this.messages.length === 0) this.contextTokens = 0
		this.measuredMessages = Math.min(this.measuredMessages, this.messages.length)
		this.stopHookActive = false
		this.autoCompactFailed = false
		this.repeatTracker.clear()
		// Persist even when nothing is left, so the rewound turns don't come
		// back on /resume.
		this.persist(true)
		return result
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
				// Whitespace-only content (common right before a tool call) is not a message.
				if (this.transcriptText.trim()) {
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
				if (this.transcriptText.trim()) {
					this.transcript.push({ kind: "assistant", text: this.transcriptText })
				}
				this.transcriptText = ""
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
		deleteBackups(this.taskId, this.checkpoints)
		this.checkpoints = []
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
		this.autoCompactFailed = false
		this.measuredMessages = 0
		this.repeatTracker.clear()
		this.lastGitHead = getGitHead(this.options.cwd)
		persistGitHead(this.options.cwd, this.lastGitHead)
	}

	/** Write the current conversation to the sessions directory. */
	private persist(force = false): void {
		if (this.messages.length === 0 && !force) return
		const filePath = getSessionFilePath(this.taskId)
		try {
			// Stale-write guard: if another process (e.g. a zombie left by an
			// unfinished quit, or a second OrbCode instance) wrote newer turns to
			// this session file, writing our older in-memory history would roll
			// the session back. Skip and warn instead of clobbering.
			if (this.lastSessionWriteMs > 0) {
				try {
					const onDiskMs = fs.statSync(filePath).mtimeMs
					if (onDiskMs > this.lastSessionWriteMs + STALE_WRITE_TOLERANCE_MS) {
						this.options.callbacks.onEvent({
							type: "system",
							message:
								"Session file was updated by another OrbCode process; skipping save to protect the newer turns.",
							isError: false,
						})
						return
					}
				} catch {
					// no file on disk yet — nothing to protect
				}
			}
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
				lastGitHead: this.lastGitHead,
				messages: this.messages,
				transcript: this.transcript,
				checkpoints: this.checkpoints,
			})
			this.lastSessionWriteMs = Date.now()
		} catch (error) {
			// Persistence is best-effort and must never break the session, but a
			// silent catch here is how whole turns vanished without a trace.
			// Surface the failure so the user knows the save didn't happen.
			this.options.callbacks.onEvent({
				type: "system",
				message: `Failed to save session: ${(error as Error).message}`,
				isError: true,
			})
		}
	}

	abort(): void {
		this.abortController?.abort()
		this.warmupController?.abort()
	}

	get isIdle(): boolean {
		return this.abortController === undefined
	}

	/** False for an agent created ahead of its first message (to warm the
	 *  prompt cache) that hasn't run a turn yet — there is no session to end. */
	get hasSession(): boolean {
		return this.sessionStarted || this.messages.length > 0
	}

	/** <system-reminder> blocks that open the first user message. */
	private contextReminders(): string {
		return buildContextReminders(this.memorySection, getGitSummary(this.options.cwd))
	}

	/** System message that follows the first user message. */
	private environmentMessage(): OpenAI.Chat.ChatCompletionSystemMessageParam {
		return {
			role: "system",
			content: buildEnvironmentMessage({
				cwd: this.options.cwd,
				isGitRepo: gitOutput(this.options.cwd, "git rev-parse --is-inside-work-tree") === "true",
				modelName: getModel(this.options.modelId).name,
				skillCatalog: this.skillCatalog,
				linkedRepos: renderLinkedReposSection(this.options.cwd),
			}),
		}
	}

	/** System message reporting the context window left, sent after each user message and tool round. */
	private tokensLeftMessage(): OpenAI.Chat.ChatCompletionSystemMessageParam {
		const window = getModel(this.options.modelId).contextWindow
		return { role: "system", content: tokensLeftNote(window - this.estimatedContextTokens()) }
	}

	/**
	 * Conversation history with internal markers stripped, ready for the model.
	 * The environment stays a system message after the first user message; the
	 * per-step <total_tokens> notes are folded into the message before them,
	 * since a gateway that hoists system messages into the leading prompt would
	 * otherwise rewrite the start of every request.
	 */
	private outgoingMessages(): OpenAI.Chat.ChatCompletionMessageParam[] {
		return foldSystemMessages(
			this.messages.map((message) =>
				message.role === "user"
					? {
							...message,
							content:
								typeof message.content === "string"
									? stripUserQueryTags(message.content)
									: message.content.map((part) =>
											part.type === "text" ? { ...part, text: stripUserQueryTags(part.text) } : part,
										),
						}
					: message,
			),
			isTokensLeftNote,
		)
	}

	/** Note appended to a tool result when the model keeps repeating the same call. */
	private repeatNote(toolCall: PendingToolCall, args: Record<string, unknown>, resultText: string, isError: boolean): string {
		if (EDIT_TOOLS.has(toolCall.name) && !isError) {
			// Files changed: earlier identical read/search/test calls may now differ.
			this.repeatTracker.clear()
			return ""
		}
		const signature = `${toolCall.name}:${JSON.stringify(args)}`
		const hash = `${resultText.length}:${resultText.slice(0, 200)}:${resultText.slice(-200)}`
		const previous = this.repeatTracker.get(signature)
		const count = previous && previous.hash === hash ? previous.count + 1 : 1
		this.repeatTracker.set(signature, { hash, count })
		if (count < REPEAT_WARN_AT) return ""
		return `[OrbCode] This is the ${count}${count === 3 ? "rd" : "th"} identical ${toolCall.name} call with identical output and no file edits in between. Repeating it will not change the result — use what you already have, change the call, or take a different approach.`
	}

	private toolContext(): ToolContext {
		return {
			cwd: this.options.cwd,
			token: this.options.token,
			signal: this.abortController?.signal,
			taskId: this.taskId,
			beforeWrite: (filePath) => {
				const checkpoint = this.checkpoints[this.checkpoints.length - 1]
				if (checkpoint) snapshotFile(this.taskId, checkpoint, filePath)
			},
			getTodos: () => this.todos,
			setTodos: (todos: string) => {
				this.todos = todos
				this.options.callbacks.onEvent({ type: "todos", todos })
			},
		}
	}

	async runTurn(userText: string, attachments: Attachment[] = []): Promise<void> {
		const { onEvent } = this.options.callbacks
		this.abortController = new AbortController()
		this.checkpoints.push({
			id: randomUUID().slice(0, 8),
			text: userText,
			...(attachments.length > 0 ? { attachments: attachments.map(attachmentSummary) } : {}),
			messageIndex: this.messages.length,
			transcriptIndex: this.transcript.length,
			todos: this.todos,
			files: [],
		})
		this.observeCommittedCode()
		this.trackBackground(reportUsageEvent(this.options.token, {
			eventType: "user_message",
			taskId: this.taskId,
			model: this.options.modelId,
			repo: detectGitRepo(this.options.cwd),
		}))
		this.transcript.push({
			kind: "user",
			text: userText,
			...(attachments.length > 0 ? { attachments: attachments.map(attachmentSummary) } : {}),
		})

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
			this.title = (userText || attachments.map((attachment) => attachment.name).join(", "))
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 80)
		}

		let userContent = `<user_query>\n${userText}\n</user_query>`
		const attachmentContext = formatAttachmentContext(attachments)
		if (attachmentContext) userContent = `${userContent}\n\n${attachmentContext}`
		const imageAttachments = attachments.filter((attachment) => attachment.kind === "image")
		if (imageAttachments.length > 0) {
			userContent = `${userContent}\n\n<attached_images>\n${imageAttachments
				.map((attachment) => `<attached_image name="${attachment.name.replace(/[\r\n"]/g, " ")}" />`)
				.join("\n")}\n</attached_images>`
		}
		const isFirstMessage = !this.firstMessageSent
		if (isFirstMessage) {
			const reminders = this.contextReminders()
			if (reminders) userContent = `${reminders}\n\n${userContent}`
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
		const backgroundNote = backgroundCommandsNote(this.taskId)
		if (backgroundNote) userContent = `${userContent}\n\n${backgroundNote}`
		const supportedImages = getModel(this.options.modelId).supportsImages ? imageAttachments : []
		if (supportedImages.length !== imageAttachments.length) {
			onEvent({ type: "system", message: "The current model does not support image attachments.", isError: true })
		}
		this.messages.push({
			role: "user",
			content:
				supportedImages.length > 0
					? [
							{ type: "text", text: userContent },
							...supportedImages.map((attachment) => ({
								type: "image_url" as const,
								image_url: { url: attachment.dataUrl },
							})),
						]
					: userContent,
		})
		this.messages.push(isFirstMessage ? this.environmentMessage() : this.tokensLeftMessage())
		// Persist immediately so a hard kill before the first model response
		// still leaves the user's prompt on disk.
		this.persist()

		// --- Auto-fetch Figma URLs from the user's message ---
		// Instead of relying on the model to call figma_fetch, we scan the
		// user's text for figma.com URLs and pre-fetch each one so the design
		// data is always available to the model from the first completion.
		// This runs once per URL, deterministically.
		const figmaUrls = extractFigmaUrls(userText)
		if (figmaUrls.length > 0) {
			const ctx = this.toolContext()
			const autoToolCalls = figmaUrls.map((figmaUrl, i) => ({
				id: `figma_auto_${Date.now()}_${i}`,
				name: "figma_fetch",
				arguments: JSON.stringify({ url: figmaUrl }),
			}))
			// Push the assistant tool_calls message so the API accepts the
			// tool results that follow.
			this.messages.push({
				role: "assistant",
				content: "",
				tool_calls: autoToolCalls.map((tc) => ({
					id: tc.id,
					type: "function" as const,
					function: { name: tc.name, arguments: tc.arguments },
				})),
			})
			for (const toolCall of autoToolCalls) {
				const summary = describeToolCall(toolCall.name, JSON.parse(toolCall.arguments))
				onEvent({ type: "tool-start", id: toolCall.id, name: toolCall.name, summary })
				const result = await figmaFetch(JSON.parse(toolCall.arguments), ctx)
				const resultText = result.text
				this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText })
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
				})
			}
		}

		try {
			this.stopHookActive = false
			// A failed auto-compaction only pauses retries for the rest of its turn.
			this.autoCompactFailed = false
			let recoveredOverflow = false
			for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
				await this.autoCompactIfNeeded()
				let done: boolean
				try {
					done = await this.runStep()
				} catch (error) {
					// The provider says the history no longer fits (e.g. a resumed
					// session on a smaller-window model, or tool output the last
					// usage report didn't cover): compact and retry the step once.
					if (recoveredOverflow || this.abortController.signal.aborted || !isContextOverflowError(error)) throw error
					recoveredOverflow = true
					const compacted = await this.autoCompact(
						"The conversation no longer fits the model's context window — compacting and retrying…",
					)
					if (!compacted) throw error
					done = await this.runStep()
				}
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
					content: systemReminder("The user interrupted this response before it finished."),
				})
		} else {
			onEvent({ type: "error", message: sanitizeErrorMessage(error) })
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
			this.messages.push({ role: "user", content: systemReminder(`Stop hook: ${reason}`) })
			return true
		}
		return false
	}

	/** Track a fire-and-forget hook promise so it can be awaited on exit. */
	private trackBackground(p: Promise<unknown>): void {
		this.pendingBackground.add(p)
		p.finally(() => this.pendingBackground.delete(p))
	}

	/** Detect descendant Git commits made while this session is alive. */
	private observeCommittedCode(): void {
		const observed = observeGitCommits(this.options.cwd, this.lastGitHead)
		this.lastGitHead = observed.head
		persistGitHead(this.options.cwd, this.lastGitHead)
		if (observed.commits.length === 0) return

		const repo = detectGitRepo(this.options.cwd)
		for (const commit of observed.commits) {
			this.trackBackground(reportUsageEvent(this.options.token, {
				eventId: `commit:${commit.hash}:${repo}`,
				eventType: "committed_code",
				taskId: this.taskId,
				model: this.options.modelId,
				repo,
				linesAdded: commit.linesAdded,
				linesDeleted: commit.linesDeleted,
				commitHash: commit.hash,
				timestamp: commit.timestamp,
			}))
		}
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
		this.observeCommittedCode()
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
		try {
			await disposeSearchFiles()
		} catch {
			// Search cleanup must not prevent the CLI from exiting.
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
			const summary = await this.summarizeWithinWindow(signal, startContext, true)
			if (summary) {
				onEvent({ type: "text-done" })
				this.replaceHistoryWithSummary(summary, false)
			} else {
				onEvent({ type: "error", message: "Compaction produced no summary; history left unchanged." })
			}
		} catch (error) {
			if ((error as Error).name === "AbortError" || signal.aborted) {
			onEvent({ type: "error", message: "Compaction interrupted; history left unchanged." })
		} else {
			onEvent({ type: "error", message: sanitizeErrorMessage(error) })
		}
		} finally {
			this.abortController = undefined
			this.recordTranscriptEvent({ type: "turn-end" })
			this.persist()
			onEvent({ type: "turn-end" })
		}
	}

	/**
	 * Summarize, shrinking the request if the provider says it doesn't fit.
	 * Throws when every budget fails (or on any non-overflow error).
	 */
	private async summarizeWithinWindow(signal: AbortSignal, startContext: string, showText: boolean): Promise<string> {
		const window = getModel(this.options.modelId).contextWindow
		let lastError: unknown
		for (const fraction of SUMMARY_BUDGET_FRACTIONS) {
			try {
				return await this.summarizeHistory(signal, startContext, showText, Math.floor(window * fraction))
			} catch (error) {
				if (signal.aborted || !isContextOverflowError(error)) throw error
				lastError = error
			}
		}
		throw lastError
	}

	/**
	 * History for the summary request. It is the whole conversation, so once
	 * the history outgrows the window it would fail exactly when compaction is
	 * needed; past `budgetTokens` it is trimmed: older tool results are
	 * stubbed, oversized messages cut, and the oldest whole turns dropped
	 * (keeping the first message — the original request or the last summary).
	 * Under budget it is the normal outgoing history, which keeps the
	 * gateway's prompt cache warm.
	 */
	private summarySource(budgetTokens: number): OpenAI.Chat.ChatCompletionMessageParam[] {
		let messages = this.outgoingMessages()
		const size = (list: OpenAI.Chat.ChatCompletionMessageParam[]) =>
			list.reduce((total, message) => total + messageTokenEstimate(message), 0)
		if (size(messages) <= budgetTokens) return messages

		const toolIndexes = messages.flatMap((message, index) => (message.role === "tool" ? [index] : []))
		const keepToolsFrom = toolIndexes[toolIndexes.length - KEEP_RECENT_TOOL_RESULTS] ?? Number.POSITIVE_INFINITY
		messages = messages.map((message, index) => {
			if (message.role !== "tool" || index >= keepToolsFrom) return message
			const lines = contentToText(message.content).split("\n").length
			return { ...message, content: `[Tool result (${lines} lines) omitted to fit the summary request.]` }
		})
		const maxMessageChars = Math.floor((budgetTokens * CHARS_PER_TOKEN) / 4)
		messages = messages.map((message) => truncateMessage(message, maxMessageChars))
		if (size(messages) <= budgetTokens || messages.length < 3) return messages

		// Drop whole turns from the front so no tool result loses its call.
		const [first, ...rest] = messages
		let start = 0
		while (size([first, ...rest.slice(start)]) > budgetTokens) {
			const next = rest.findIndex((message, index) => index > start && message.role === "user")
			if (next === -1) break
			start = next
		}
		if (start === 0) return messages
		return [
			first,
			{ role: "user", content: `[${start} earlier messages omitted to fit the context window.]` },
			...rest.slice(start),
		]
	}

	/** Ask the model to summarize the conversation so far. `showText` streams the summary to the UI. */
	private async summarizeHistory(
		signal: AbortSignal,
		startContext: string,
		showText: boolean,
		budgetTokens: number,
	): Promise<string> {
		const { onEvent } = this.options.callbacks
		const request: OpenAI.Chat.ChatCompletionMessageParam[] = [
			...this.summarySource(budgetTokens),
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
				if (showText) onEvent({ type: "stream-reset" })
				return true
			},
		)) {
			if (signal.aborted) throw new DOMException("aborted", "AbortError")
			if (chunk.type === "text") {
				summary += chunk.text
				if (showText) onEvent({ type: "text-delta", text: chunk.text })
			} else if (chunk.type === "usage") {
				this.totalCost += chunk.totalCost ?? 0
				onEvent({
					type: "usage",
					inputTokens: chunk.inputTokens,
					outputTokens: chunk.outputTokens,
					cost: chunk.totalCost ?? 0,
					totalCost: this.totalCost,
				})
			}
		}
		return summary
	}

	/**
	 * Swap the whole history for a single summary message. A user message the
	 * model hasn't answered yet (compaction right as a turn starts) is kept
	 * verbatim after it, so the new request isn't lost in the summary.
	 */
	private replaceHistoryWithSummary(summary: string, continueWork: boolean): void {
		// The unanswered user message, if any, is the last one apart from
		// trailing harness system messages (which are regenerated below).
		let lastIndex = this.messages.length - 1
		while (lastIndex >= 0 && this.messages[lastIndex]?.role === "system") lastIndex--
		const last = this.messages[lastIndex]
		const pending = continueWork && last?.role === "user" ? last : undefined
		const reminders = this.contextReminders()
		this.messages = [
			{
				role: "user",
				content:
					(reminders ? `${reminders}\n\n` : "") +
					`# Conversation Summary\n\nThe conversation history was compacted. Summary of everything so far:\n\n${summary}` +
					(continueWork
						? "\n\nContinue the work described above from where it left off. Do not restart or repeat steps that are already done."
						: ""),
			},
			this.environmentMessage(),
			...(pending ? [pending] : []),
		]
		// The summary is small; the next usage report replaces this estimate.
		this.contextTokens = this.messages.reduce((total, message) => total + messageTokenEstimate(message), 0)
		this.measuredMessages = this.messages.length
		if (pending) this.messages.push(this.tokensLeftMessage())
		this.autoCompactFailed = false
		// Checkpoints index into the history that was just replaced.
		deleteBackups(this.taskId, this.checkpoints)
		this.checkpoints = []
		this.repeatTracker.clear()
	}

	/**
	 * Compact mid-turn when the context nears the window, so long tasks keep
	 * getting faster, cheaper steps instead of degrading. Failure is non-fatal:
	 * the turn continues with the full history and won't retry compaction.
	 */
	private async autoCompactIfNeeded(): Promise<void> {
		if (this.autoCompactFailed || this.messages.length < 4) return
		const window = getModel(this.options.modelId).contextWindow
		const estimated = this.estimatedContextTokens()
		if (estimated < window * AUTO_COMPACT_FRACTION) return
		const percent = Math.round((estimated / window) * 100)
		await this.autoCompact(`Context is ${percent}% full — compacting the conversation…`)
	}

	/** Context the next request will carry: the last measured size plus an
	 *  estimate for everything added since (tool results, new input). */
	private estimatedContextTokens(): number {
		let unmeasured = 0
		for (const message of this.messages.slice(this.measuredMessages)) unmeasured += messageTokenEstimate(message)
		return this.contextTokens + unmeasured
	}

	/** Compact mid-turn and continue. Returns false (and pauses auto-compaction
	 *  for the rest of the turn) when it fails. */
	private async autoCompact(message: string): Promise<boolean> {
		const { onEvent } = this.options.callbacks
		const signal = this.abortController!.signal
		onEvent({ type: "system", message, isError: false })
		if (this.hooks.hasHooks("PreCompact")) {
			await this.hooks.run("PreCompact", { trigger: "auto", custom_instructions: "" })
		}
		try {
			const summary = await this.summarizeWithinWindow(signal, "", false)
			if (!summary) throw new Error("no summary produced")
			this.replaceHistoryWithSummary(summary, true)
			onEvent({ type: "system", message: "Conversation compacted; continuing.", isError: false })
			return true
		} catch (error) {
			if ((error as Error).name === "AbortError" || signal.aborted) throw error
			this.autoCompactFailed = true
			onEvent({
				type: "system",
				message: `Auto-compaction failed (${sanitizeErrorMessage(error)}); continuing with the full history.`,
				isError: true,
			})
			return false
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
					message: `${streamErrorLabel(error)}. Retrying ${attempt + 1}/${MAX_STREAM_RETRIES} in ${Math.ceil(delayMs / 1000)}s…`,
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
		// the live "Thinking" block stops before the answer streams. A fresh
		// segment can re-open if the model interleaves reasoning with content.
		let reasoningOpen = false
		let reasoningStart = 0
		let reasoningText = ""
		let reasoningDetails: unknown
		// Once reasoning-done has been emitted the thinking segment is closed out
		// and can't be rolled back, so a mid-stream retry after that point isn't clean.
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
		let usageReported = false

		// Roll back this step's partial output so streamWithRetry can restart a
		// dropped stream mid-flight. Tools only run after the stream completes, so
		// nothing irreversible has happened yet; the one thing we can't undo is an
		// already-committed reasoning row, so we decline the restart in that case.
		const rollbackForRetry = (): boolean => {
			if (reasoningRowCommitted) return false
			assistantText = ""
			reasoningOpen = false
			reasoningStart = 0
			reasoningText = ""
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
					reasoningText += chunk.text
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
					usageReported = true
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
			content: assistantText.trim() ? assistantText : null,
		}
		if (toolCalls.length > 0) {
			assistantMessage.tool_calls = toolCalls.map((tc) => ({
				id: tc.id,
				type: "function" as const,
				function: { name: tc.name, arguments: tc.arguments || "{}" },
			}))
		}
		// Replay this step's reasoning verbatim on every later request, as other
		// OpenAI-compatible clients do: the model sees its earlier thinking and the
		// message never changes, so the provider's prompt cache keeps matching.
		// Left off when there is none (strict endpoints reject unknown fields).
		if (reasoningText) {
			;(assistantMessage as unknown as Record<string, unknown>)[REASONING_CONTENT_FIELD] = reasoningText
		}
		// Stash reasoning blocks (opaque) so the next turn can replay them. The
		// field is persisted with the session and stripped on the OpenAI path.
		if (reasoningDetails !== undefined) {
			;(assistantMessage as unknown as Record<string, unknown>)[REASONING_DETAILS_FIELD] = reasoningDetails
		}
		this.messages.push(assistantMessage)
		// The report's output tokens already cover this assistant message.
		if (usageReported) this.measuredMessages = this.messages.length

		if (toolCalls.length === 0) {
			return true
		}

		let completed = false
		const runToolCall = async (toolCall: PendingToolCall): Promise<void> => {
			const resultText = await this.handleToolCall(toolCall)
			this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: resultText })
			if (toolCall.name === "attempt_completion") {
				completed = true
			}
		}

		// Independent read-only calls (the leading run of the response) execute
		// concurrently, at most MAX_PARALLEL_READ_ONLY_TOOLS at a time. Results are
		// committed in model order so tool_call/tool_result pairing stays intact;
		// mutating and interactive calls remain on the serialized path.
		let batchEnd = 0
		while (batchEnd < toolCalls.length && isParallelReadOnlyCall(toolCalls[batchEnd])) {
			batchEnd++
		}

		if (batchEnd > 1) {
			const batch = toolCalls.slice(0, batchEnd)
			const results = new Array<string>(batch.length)
			let nextIndex = 0
			await Promise.all(
				Array.from({ length: Math.min(MAX_PARALLEL_READ_ONLY_TOOLS, batch.length) }, async () => {
					while (nextIndex < batch.length) {
						const index = nextIndex++
						results[index] = await this.handleToolCall(batch[index])
					}
				}),
			)
			for (const [index, toolCall] of batch.entries()) {
				this.messages.push({ role: "tool", tool_call_id: toolCall.id, content: results[index] })
			}
		} else {
			for (let index = 0; index < batchEnd; index++) {
				await runToolCall(toolCalls[index])
			}
		}
		for (let index = batchEnd; index < toolCalls.length; index++) {
			await runToolCall(toolCalls[index])
		}
		if (!completed) this.messages.push(this.tokensLeftMessage())
		// Persist after every model step: a hard kill mid-turn (crash, closed
		// terminal, kill signal) loses at most the in-flight tool call instead
		// of the entire turn's accumulated history.
		this.persist()
		return completed
	}

	private async handleToolCall(toolCall: PendingToolCall): Promise<string> {
		const { onEvent, requestApproval, requestFollowup } = this.options.callbacks

		const parsed = parseToolCallArguments(toolCall.arguments)
		if (!parsed) {
			// Recover instead of dead-ending: the error result carries the raw
			// arguments so the model can re-issue the call with valid, complete JSON.
			const rawArgs = toolCall.arguments.trim()
			const preview = rawArgs.length > 500 ? `${rawArgs.slice(0, 500)}...(truncated)` : rawArgs
			const message = `Malformed tool call JSON for ${toolCall.name}: the arguments could not be parsed or repaired. The raw arguments were:\n\n${preview}\n\nPlease re-issue the tool call with valid, complete JSON arguments.`
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
		let args = parsed.args
		// A repair surfaces twice: a transcript event for the user, and a note on
		// the tool result so the model sees the arguments that actually ran.
		const repairNote = parsed.repaired ? jsonRepairNote(toolCall.name, args) : ""
		if (parsed.repaired) {
			onEvent({
				type: "system",
				message: `Repaired malformed JSON arguments for ${toolCall.name}.`,
				isError: false,
			})
		}

		if (toolCall.name === "attempt_completion") {
			onEvent({ type: "completion", result: String(args.result ?? "") })
			return repairNote
				? `The user has been shown the completion result.\n\n${repairNote}`
				: "The user has been shown the completion result."
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
			return `<answer>\n${answer}\n</answer>${repairNote ? `\n\n${repairNote}` : ""}`
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
		const isDangerous = (toolCall.name === "Bash" || toolCall.name === "execute_command") && Boolean(args.isDangerous)
		let needsApproval = false
		if (approvalKind === "edit" && !this.sessionApproveEdits) needsApproval = true
		if (approvalKind === "command") {
			const readOnly = !isDangerous && isReadOnlyCommand(String(args.command ?? ""))
			needsApproval = isDangerous || !(readOnly || this.sessionApproveCommands || this.options.autoApproveSafeCommands)
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
		this.observeCommittedCode()

		// PostToolUse can feed extra context (or a block reason) back to the
		// model. PreToolUse additionalContext is delivered here too.
		let resultText = result.text
		const extras: string[] = []
		if (repairNote) extras.push(repairNote)
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
		const repeat = this.repeatNote(toolCall, args, result.text, Boolean(result.isError))
		if (repeat) extras.push(repeat)
		if (extras.length) resultText += `\n\n${extras.join("\n\n")}`

		// Report accepted code metrics for successful file edits. This covers
		// both user-approved and auto-approved edits — the call only happens
		// after the write has landed on disk. Best-effort; never blocks.
		if (!result.isError && approvalKind === "edit" && diff) {
			const filePath = toolCall.name === "multi_file_edit"
				? String((Array.isArray(args.edits) ? args.edits[0] : args)?.file_path ?? "")
			: String(args.file_path ?? "")
			const { linesAdded, linesDeleted } = countDiffLines(diff)
			if (linesAdded > 0 || linesDeleted > 0) {
				this.trackBackground(reportLineMetrics({
					taskId: this.taskId,
					token: this.options.token,
					repo: detectGitRepo(this.options.cwd),
					language: getLanguageFromPath(filePath),
					linesAdded,
					linesDeleted,
					model: this.options.modelId,
				}))
			}
		}

		const resultPreview = formatResultPreview(toolCall.name, resultText)

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
