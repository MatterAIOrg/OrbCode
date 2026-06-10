import { execSync } from "node:child_process"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import type OpenAI from "openai"

import { AxonClient } from "../api/client.js"
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
import type { AgentCallbacks, ApprovalDecision } from "./events.js"
import { saveSession, type SessionData } from "./sessions.js"

const MAX_STEPS_PER_TURN = 50
const RESULT_PREVIEW_LINES = 6

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
		const status = execSync("git status --short | head -20", { cwd, stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trimEnd()
		return `# Git\nBranch: ${branch}\n${status ? `Working tree changes:\n${status}` : "Working tree clean"}`
	} catch {
		return ""
	}
}

export class Agent {
	private options: AgentOptions
	private client: AxonClient
	private systemPrompt: string
	private messages: OpenAI.Chat.ChatCompletionMessageParam[] = []
	private todos = ""
	private firstMessageSent = false
	private sessionApproveEdits: boolean
	private sessionApproveCommands = false
	private abortController?: AbortController
	private totalCost = 0
	private title = ""
	private createdAt = new Date().toISOString()
	readonly taskId: string

	constructor(options: AgentOptions) {
		this.options = options
		this.taskId = options.resume?.id ?? randomUUID()
		if (options.resume) {
			this.messages = options.resume.messages
			this.todos = options.resume.todos
			this.totalCost = options.resume.totalCost
			this.title = options.resume.title
			this.createdAt = options.resume.createdAt
			this.firstMessageSent = this.messages.length > 0
		}
		this.sessionApproveEdits = options.autoApproveEdits
		this.systemPrompt = buildSystemPrompt(options.cwd)
		this.client = new AxonClient({
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
		this.client = new AxonClient({
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

	/** Replace the prompt-derived title with the backend-generated one. */
	setTitle(title: string): void {
		this.title = title
		this.persist()
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
		this.todos = ""
		this.firstMessageSent = false
		this.totalCost = 0
		this.title = ""
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
				todos: this.todos,
				messages: this.messages,
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
		return `<environment_details>
# Current Workspace Directory (${this.options.cwd}) Files
${files.join("\n") || "(empty directory)"}
${files.length >= 200 ? "\n(File list truncated.)" : ""}

${git}

# Current Time
${new Date().toString()}
</environment_details>`
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
		if (!this.title) {
			this.title = userText.replace(/\s+/g, " ").trim().slice(0, 80)
		}

		let userContent = `<user_query>\n${userText}\n</user_query>`
		if (!this.firstMessageSent) {
			userContent = `${this.buildEnvironmentDetails()}\n\n${userContent}`
			this.firstMessageSent = true
		}
		this.messages.push({ role: "user", content: userContent })

		try {
			for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
				const done = await this.runStep()
				if (done) break
			}
		} catch (error) {
			if ((error as Error).name === "AbortError" || this.abortController.signal.aborted) {
				onEvent({ type: "error", message: "Interrupted." })
				// Keep the conversation consistent: note the interruption for the model.
				this.messages.push({
					role: "user",
					content: "<system_reminder>The user interrupted this response before it finished.</system_reminder>",
				})
			} else {
				onEvent({ type: "error", message: (error as Error).message })
			}
		} finally {
			this.abortController = undefined
			this.persist()
			onEvent({ type: "turn-end" })
		}
	}

	/** Summarize the conversation so far and replace history with the summary. */
	async compact(): Promise<void> {
		const { onEvent } = this.options.callbacks
		if (this.messages.length === 0) {
			onEvent({ type: "error", message: "Nothing to compact yet." })
			onEvent({ type: "turn-end" })
			return
		}
		this.abortController = new AbortController()
		const signal = this.abortController.signal
		try {
			const request: OpenAI.Chat.ChatCompletionMessageParam[] = [
				...this.messages,
				{
					role: "user",
					content:
						"Summarize this conversation so it can replace the full history. Capture the user's goals, decisions made, files created or modified (with paths), important code details, and any remaining next steps. Be thorough but concise. Respond with only the summary.",
				},
			]
			let summary = ""
			for await (const chunk of this.client.createMessage(this.systemPrompt, request, [], signal)) {
				if (signal.aborted) throw new DOMException("aborted", "AbortError")
				if (chunk.type === "text") {
					summary += chunk.text
					onEvent({ type: "text-delta", text: chunk.text })
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
			if (summary) {
				onEvent({ type: "text-done" })
				this.messages = [
					{
						role: "user",
						content: `<conversation_summary>\nThe conversation history was compacted. Summary of everything so far:\n\n${summary}\n</conversation_summary>`,
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
			this.persist()
			onEvent({ type: "turn-end" })
		}
	}

	/** Run one model request + tool execution round. Returns true when the turn is over. */
	private async runStep(): Promise<boolean> {
		const { onEvent } = this.options.callbacks
		const signal = this.abortController!.signal

		let assistantText = ""
		let hadReasoning = false
		let reasoningStart = 0
		const toolCallsByIndex = new Map<number, PendingToolCall>()
		let nextSyntheticIndex = 10000

		const stream = this.client.createMessage(this.systemPrompt, this.messages, getActiveTools(), signal)

		for await (const chunk of stream) {
			if (signal.aborted) throw new DOMException("aborted", "AbortError")
			switch (chunk.type) {
				case "text":
					assistantText += chunk.text
					onEvent({ type: "text-delta", text: chunk.text })
					break
				case "reasoning":
					if (!hadReasoning) {
						hadReasoning = true
						reasoningStart = Date.now()
					}
					onEvent({ type: "reasoning-delta", text: chunk.text })
					break
				case "native_tool_calls":
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

		if (hadReasoning) {
			onEvent({ type: "reasoning-done", durationMs: Date.now() - reasoningStart })
		}
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

		const summary = describeToolCall(toolCall.name, args)

		if (toolCall.name === "attempt_completion") {
			onEvent({ type: "completion", result: String(args.result ?? "") })
			return "The user has been shown the completion result."
		}

		if (toolCall.name === "ask_followup_question") {
			const question = String(args.question ?? "")
			const suggestions = (Array.isArray(args.follow_up) ? args.follow_up : [])
				.map((s: { text?: string }) => ({ text: String(s?.text ?? "") }))
				.filter((s: { text: string }) => s.text)
			const answer = await requestFollowup(question, suggestions)
			return `<answer>\n${answer}\n</answer>`
		}

		onEvent({ type: "tool-start", id: toolCall.id, name: toolCall.name, summary })

		const approvalKind = getApprovalKind(toolCall.name, args)
		const diff = approvalKind === "edit" ? previewFileChange(toolCall.name, args, this.options.cwd) : undefined
		const isDangerous = toolCall.name === "execute_command" && Boolean(args.isDangerous)
		let needsApproval = false
		if (approvalKind === "edit" && !this.sessionApproveEdits) needsApproval = true
		if (approvalKind === "command") {
			needsApproval = isDangerous || !(this.sessionApproveCommands || this.options.autoApproveSafeCommands)
		}

		if (needsApproval) {
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

		const result = await executeTool(toolCall.name, args, this.toolContext())

		const previewLines = result.text.split("\n")
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

		return result.text
	}
}
