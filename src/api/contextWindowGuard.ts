import type OpenAI from "openai"

import type { LLMClient } from "./llmClient.js"
import type { AxonModel } from "./models.js"
import type { ApiStreamChunk } from "./stream.js"

export const CONTEXT_WINDOW_SAFETY_PERCENTAGE = 0.1

const REQUEST_OVERHEAD_TOKENS = 512
const MESSAGE_OVERHEAD_TOKENS = 32
const TOOL_OVERHEAD_TOKENS = 32
const IMAGE_MINIMUM_TOKENS = 16_384
const REMOTE_IMAGE_TOKENS = 64_000
const TRUNCATION_MARKER = "\n[...content truncated to fit the selected model's context window...]\n"
const HISTORY_OMISSION_MARKER =
	"[Earlier conversation turns were omitted by OrbCode's context-window guard before this request.]"

type Message = OpenAI.Chat.ChatCompletionMessageParam
type ToolDefinition = OpenAI.Chat.ChatCompletionTool
type MutableMessage = Message & Record<string, unknown>

export interface PreparedContextWindowRequest {
	systemPrompt: string
	messages: Message[]
	tools: ToolDefinition[]
	contextWindow: number
	outputTokenReserve: number
	inputTokenBudget: number
	estimatedInputTokens: number
	originalEstimatedInputTokens: number
	wasTruncated: boolean
}

interface MutableRequest {
	systemPrompt: string
	messages: MutableMessage[]
	tools: ToolDefinition[]
}

/** Install one final request boundary around either OrbCode transport. */
export class ContextWindowGuardClient implements LLMClient {
	constructor(
		private readonly delegate: LLMClient,
		private readonly model: AxonModel,
	) {}

	async *createMessage(
		systemPrompt: string,
		messages: Message[],
		tools: ToolDefinition[],
		abortSignal?: AbortSignal,
	): AsyncGenerator<ApiStreamChunk> {
		const prepared = prepareContextWindowRequest({
			model: this.model,
			systemPrompt,
			messages,
			tools,
		})

		yield* this.delegate.createMessage(
			prepared.systemPrompt,
			prepared.messages,
			prepared.tools,
			abortSignal,
		)
	}
}

export function prepareContextWindowRequest({
	model,
	systemPrompt,
	messages,
	tools,
}: {
	model: AxonModel
	systemPrompt: string
	messages: Message[]
	tools: ToolDefinition[]
}): PreparedContextWindowRequest {
	const contextWindow = validateTokenLimit(model.contextWindow, "context window")
	const outputTokenReserve = validateTokenLimit(model.maxOutputTokens, "maximum output")
	const inputTokenBudget = Math.floor(
		contextWindow * (1 - CONTEXT_WINDOW_SAFETY_PERCENTAGE) - outputTokenReserve,
	)

	if (inputTokenBudget <= REQUEST_OVERHEAD_TOKENS) {
		throw contextWindowError(model, REQUEST_OVERHEAD_TOKENS, inputTokenBudget)
	}

	let request: MutableRequest = {
		systemPrompt,
		messages: messages.map(cloneMessage),
		tools: tools.map(cloneTool),
	}
	const originalEstimatedInputTokens = estimateContextWindowInput(request)
	let estimatedInputTokens = originalEstimatedInputTokens

	if (estimatedInputTokens <= inputTokenBudget) {
		return {
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
			contextWindow,
			outputTokenReserve,
			inputTokenBudget,
			estimatedInputTokens,
			originalEstimatedInputTokens,
			wasTruncated: false,
		}
	}

	for (let round = 0; round < 6 && estimatedInputTokens > inputTokenBudget; round++) {
		const ratio = Math.max(0.01, Math.min(0.85, (inputTokenBudget / estimatedInputTokens) * 0.82))
		request = shrinkRequest(request, ratio, round)
		estimatedInputTokens = estimateContextWindowInput(request)
	}

	while (estimatedInputTokens > inputTokenBudget && request.messages.length > 4) {
		const shortened = dropOldestConversationPrefix(request.messages)
		if (shortened.length === request.messages.length) break
		request.messages = shortened
		estimatedInputTokens = estimateContextWindowInput(request)
	}

	if (estimatedInputTokens > inputTokenBudget) {
		request = aggressivelyCompactRequest(request)
		estimatedInputTokens = estimateContextWindowInput(request)
	}

	if (estimatedInputTokens > inputTokenBudget) {
		throw contextWindowError(model, estimatedInputTokens, inputTokenBudget)
	}

	return {
		systemPrompt: request.systemPrompt,
		messages: request.messages,
		tools: request.tools,
		contextWindow,
		outputTokenReserve,
		inputTokenBudget,
		estimatedInputTokens,
		originalEstimatedInputTokens,
		wasTruncated: true,
	}
}

/**
 * Conservative tokenizer-independent upper bound. UTF-8 byte length is at
 * least as large as the byte-level token count used by supported text models;
 * explicit structure and vision allowances are added separately.
 */
export function estimateContextWindowInput(request: {
	systemPrompt: string
	messages: Message[]
	tools: ToolDefinition[]
}): number {
	let total = REQUEST_OVERHEAD_TOKENS + utf8Length(safeJsonStringify(request.systemPrompt))

	for (const message of request.messages) {
		total += MESSAGE_OVERHEAD_TOKENS + estimateMessage(message)
	}
	for (const tool of request.tools) {
		total += TOOL_OVERHEAD_TOKENS + utf8Length(safeJsonStringify(tool))
	}

	return total
}

function validateTokenLimit(value: number, label: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`Invalid model ${label}: ${value}. No LLM call was made.`)
	}
	return Math.floor(value)
}

function contextWindowError(model: AxonModel, estimatedInputTokens: number, inputTokenBudget: number): Error {
	return new Error(
		`Context window guard stopped an unsafe request for ${model.id}: ` +
			`${estimatedInputTokens} conservatively estimated input tokens exceed the ${inputTokenBudget}-token input budget ` +
			`(${model.contextWindow}-token context window, ${model.maxOutputTokens} tokens reserved for output). ` +
			`No LLM call was made.`,
	)
}

function estimateMessage(message: Message): number {
	const record = message as unknown as Record<string, unknown>
	// Count the complete serialized object so newly introduced/provider-specific
	// fields cannot bypass the guard. Vision gets an additional allowance because
	// providers tokenize image pixels rather than the JSON URL alone.
	return utf8Length(safeJsonStringify(message)) + estimateImageAllowances(record.content)
}

function estimateImageAllowances(content: unknown): number {
	if (!Array.isArray(content)) return 0
	let total = 0
	for (const part of content) {
		if (!part || typeof part !== "object") continue
		const record = part as Record<string, unknown>
		if (record.type === "image_url") total += estimateImage(record.image_url)
	}
	return total
}

function estimateImage(image: unknown): number {
	const url =
		typeof image === "string"
			? image
			: image && typeof image === "object" && "url" in image
				? String((image as { url?: unknown }).url ?? "")
				: ""
	if (!url.startsWith("data:")) return REMOTE_IMAGE_TOKENS
	const comma = url.indexOf(",")
	const encodedLength = comma >= 0 ? url.length - comma - 1 : url.length
	const decodedBytes = Math.ceil((encodedLength * 3) / 4)
	return Math.max(IMAGE_MINIMUM_TOKENS, decodedBytes)
}

function cloneMessage(message: Message): MutableMessage {
	return structuredClone(message) as MutableMessage
}

function cloneTool(tool: ToolDefinition): ToolDefinition {
	return structuredClone(tool)
}

function shrinkRequest(request: MutableRequest, ratio: number, round: number): MutableRequest {
	const lastIndex = request.messages.length - 1
	return {
		systemPrompt: truncateText(
			request.systemPrompt,
			scaledLength(request.systemPrompt, round < 2 ? Math.max(0.65, ratio) : ratio, round < 3 ? 2_048 : 512),
		),
		messages: request.messages.map((message, index) => {
			const distanceFromNewest = lastIndex - index
			const ageMultiplier = distanceFromNewest > 6 ? 0.35 : distanceFromNewest > 3 ? 0.6 : 1
			return shrinkMessage(message, Math.max(0.01, ratio * ageMultiplier), round)
		}),
		tools: request.tools.map((tool) => shrinkToolDefinition(tool, ratio)),
	}
}

function shrinkMessage(message: MutableMessage, ratio: number, round: number): MutableMessage {
	const copy = { ...message } as MutableMessage
	;(copy as Record<string, unknown>).content = shrinkContent(message.content, ratio, round)

	if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
		copy.tool_calls = message.tool_calls.map((call) => {
			if (call.type !== "function") return call
			const argumentsText = call.function.arguments
			const limit = scaledLength(argumentsText, ratio, round < 3 ? 128 : 48)
			return argumentsText.length <= limit
				? call
				: {
						...call,
						function: {
							...call.function,
							arguments: JSON.stringify({
								_context_window_guard: truncateText(argumentsText, Math.max(16, limit)),
							}),
						},
					}
		})
	}

	return copy
}

function shrinkContent(content: unknown, ratio: number, round: number): unknown {
	if (typeof content === "string") {
		return truncateText(content, scaledLength(content, ratio, round < 3 ? 128 : 32))
	}
	if (!Array.isArray(content)) return content

	return content.map((part) => {
		if (!part || typeof part !== "object") return part
		const record = part as Record<string, unknown>
		if (record.type === "text" && typeof record.text === "string") {
			return {
				...record,
				text: truncateText(record.text, scaledLength(record.text, ratio, round < 3 ? 128 : 32)),
			}
		}
		return part
	})
}

function shrinkToolDefinition(tool: ToolDefinition, ratio: number): ToolDefinition {
	if (tool.type !== "function") return tool
	const description = tool.function.description
	return {
		...tool,
		function: {
			...tool.function,
			...(description
				? { description: truncateText(description, scaledLength(description, Math.max(0.1, ratio), 48)) }
				: {}),
			parameters: shrinkSchemaDescriptions(
				tool.function.parameters,
				ratio,
			) as typeof tool.function.parameters,
		},
	}
}

function shrinkSchemaDescriptions(value: unknown, ratio: number, key?: string): unknown {
	if (typeof value === "string") {
		return key === "description" || key === "title"
			? truncateText(value, scaledLength(value, Math.max(0.1, ratio), 32))
			: value
	}
	if (Array.isArray(value)) return value.map((item) => shrinkSchemaDescriptions(item, ratio))
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([childKey, childValue]) => [
				childKey,
				shrinkSchemaDescriptions(childValue, ratio, childKey),
			]),
		)
	}
	return value
}

function dropOldestConversationPrefix(messages: MutableMessage[]): MutableMessage[] {
	if (messages.length <= 4) return messages
	let boundary = Math.max(1, Math.floor(messages.length / 2))
	while (boundary < messages.length && messages[boundary].role !== "user") boundary++
	if (boundary >= messages.length) return messages

	const retained = messages.slice(boundary).map((message) => ({ ...message }))
	;(retained[0] as Record<string, unknown>).content = prependTextContent(
		retained[0].content,
		HISTORY_OMISSION_MARKER,
	)
	return retained
}

function prependTextContent(content: unknown, text: string): unknown {
	if (typeof content === "string") return `${text}\n\n${content}`
	if (Array.isArray(content)) return [{ type: "text", text }, ...content]
	return text
}

function aggressivelyCompactRequest(request: MutableRequest): MutableRequest {
	let messages = request.messages
	if (messages.length > 3) messages = dropOldestConversationPrefix(messages)
	messages = messages.map((message) => {
		const compacted = shrinkMessage(message, 0.003, 10)
		if (!Array.isArray(compacted.content)) return compacted
		return {
			...compacted,
			content: compacted.content.map((part) => {
				if (part && typeof part === "object" && "type" in part && part.type === "image_url") {
					return { type: "text", text: "[Image omitted by OrbCode's context-window guard.]" }
				}
				return part
			}),
		} as MutableMessage
	})

	return {
		systemPrompt: truncateText(request.systemPrompt, 1_024),
		messages,
		tools: [],
	}
}

function scaledLength(text: string, ratio: number, minimum: number): number {
	return Math.min(text.length, Math.max(minimum, Math.floor(text.length * ratio)))
}

export function truncateContextText(text: string, maxCharacters: number): string {
	return truncateText(text, maxCharacters)
}

function truncateText(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) return text
	if (maxCharacters <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, maxCharacters))
	const available = maxCharacters - TRUNCATION_MARKER.length
	const headLength = Math.floor(available * 0.35)
	return `${text.slice(0, headLength)}${TRUNCATION_MARKER}${text.slice(-(available - headLength))}`
}

function utf8Length(value: unknown): number {
	return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value)
	} catch (error) {
		throw new Error(
			`Context window guard could not safely estimate an unserializable request value: ${String(error)}. ` +
				"No LLM call was made.",
		)
	}
}
