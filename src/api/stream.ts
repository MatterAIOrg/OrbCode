// Stream chunk model ported from the Orbital extension (api/transform/stream.ts).
export type ApiStreamChunk =
	| ApiStreamTextChunk
	| ApiStreamReasoningChunk
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
