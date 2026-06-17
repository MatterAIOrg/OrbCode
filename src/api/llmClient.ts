import type OpenAI from "openai"

import type { ApiStreamChunk } from "./stream.js"

/**
 * The transport contract the agent loop depends on. Both the MatterAI/Axon
 * client (OpenAI `/chat/completions`) and the Vercel AI SDK client (any other
 * provider, via `/v1/messages` etc.) implement this, so `agent.ts` never has to
 * know which backend is in use. Messages and tools are always passed in the
 * OpenAI shape the rest of the app speaks; each client translates at its own
 * boundary.
 */
export interface LLMClient {
	createMessage(
		systemPrompt: string,
		messages: OpenAI.Chat.ChatCompletionMessageParam[],
		tools: OpenAI.Chat.ChatCompletionTool[],
		abortSignal?: AbortSignal,
	): AsyncGenerator<ApiStreamChunk>
}

/**
 * Non-standard field stashed on a persisted assistant message holding opaque
 * reasoning blocks (with provider signatures) for same-model replay. Only the
 * AI SDK client reads/writes it; it is stripped before any OpenAI request.
 */
export const REASONING_DETAILS_FIELD = "_reasoningDetails"

/** Drop the reasoning side-channel from assistant messages bound for an OpenAI
 *  `/chat/completions` request (it isn't a valid input field there). */
export function stripReasoningDetails(
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
	return messages.map((message) => {
		if (message.role !== "assistant") return message
		const record = message as unknown as Record<string, unknown>
		if (!(REASONING_DETAILS_FIELD in record)) return message
		const { [REASONING_DETAILS_FIELD]: _omit, ...rest } = record
		return rest as unknown as OpenAI.Chat.ChatCompletionMessageParam
	})
}
