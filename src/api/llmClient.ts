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

	/**
	 * Prime the provider's prompt cache with `systemPrompt` + `tools` (one
	 * output token) so the task's first real request starts warm. Optional:
	 * clients without a shared prompt cache simply don't implement it.
	 */
	warmup?(
		systemPrompt: string,
		tools: OpenAI.Chat.ChatCompletionTool[],
		abortSignal?: AbortSignal,
	): Promise<void>
}

/**
 * Non-standard field stashed on a persisted assistant message holding opaque
 * reasoning blocks (with provider signatures) for same-model replay. Only the
 * AI SDK client reads/writes it; it is stripped before any OpenAI request.
 */
export const REASONING_DETAILS_FIELD = "_reasoningDetails"

/**
 * The OpenAI-compatible field carrying an assistant message's reasoning text.
 * Stored on the message and replayed unchanged on the OpenAI path; the AI SDK
 * client replays `REASONING_DETAILS_FIELD` instead and ignores this one.
 */
export const REASONING_CONTENT_FIELD = "reasoning_content"

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

/**
 * Fold mid-conversation system messages selected by `shouldFold` into the
 * message before them (the user message or last tool result), or into a new
 * user message when there is none. Used for content a destination can't take
 * as a system turn in place: gateways that hoist every system message into the
 * leading system prompt, and providers that only accept a leading one. A
 * hoisted note that changes each step would rewrite the start of every request
 * and defeat the prompt cache; folded in place, the request prefix stays
 * byte-stable.
 */
export function foldSystemMessages(
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
	shouldFold: (text: string) => boolean,
): OpenAI.Chat.ChatCompletionMessageParam[] {
	const out: OpenAI.Chat.ChatCompletionMessageParam[] = []
	for (const message of messages) {
		const text = message.role === "system" ? systemText(message.content) : ""
		if (message.role !== "system" || !shouldFold(text)) {
			out.push(message)
			continue
		}
		const previous = out[out.length - 1]
		if (previous?.role === "user" || previous?.role === "tool") {
			out[out.length - 1] = appendText(previous, text)
		} else {
			out.push({ role: "user", content: text })
		}
	}
	return out
}

function systemText(content: OpenAI.Chat.ChatCompletionSystemMessageParam["content"]): string {
	return typeof content === "string" ? content : content.map((part) => part.text).join("")
}

function appendText<T extends OpenAI.Chat.ChatCompletionUserMessageParam | OpenAI.Chat.ChatCompletionToolMessageParam>(
	message: T,
	text: string,
): T {
	if (typeof message.content === "string") return { ...message, content: `${message.content}\n\n${text}` }
	return { ...message, content: [...message.content, { type: "text", text }] } as T
}
