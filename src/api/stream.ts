// Stream chunk model ported from the Orbital extension (api/transform/stream.ts).
export type ApiStreamChunk =
	| ApiStreamTextChunk
	| ApiStreamReasoningChunk
	| ApiStreamReasoningDetailsChunk
	| ApiStreamNativeToolCallsChunk
	| ApiStreamUsageChunk

export interface ApiStreamTextChunk {
	type: "text"
	text: string
}

export interface ApiStreamReasoningChunk {
	type: "reasoning"
	text: string
}

/**
 * Opaque, provider-specific reasoning blocks (with their signatures) emitted
 * once at the end of an assistant turn. The agent stashes `details` on the
 * assistant message so the producing client can replay it verbatim on the next
 * turn (Anthropic requires thinking blocks to round-trip unchanged on the same
 * model). Only the AI SDK client produces/consumes this; AxonClient strips it.
 */
export interface ApiStreamReasoningDetailsChunk {
	type: "reasoning_details"
	details: unknown
}

export interface ApiStreamNativeToolCallsChunk {
	type: "native_tool_calls"
	toolCalls: Array<{
		index?: number
		id?: string
		type?: string
		function?: {
			name: string
			arguments: string
		}
	}>
}

export interface ApiStreamUsageChunk {
	type: "usage"
	inputTokens: number
	outputTokens: number
	cacheReadTokens?: number
	reasoningTokens?: number
	totalCost?: number
	inferenceProvider?: string
}
