import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import {
	jsonSchema,
	streamText,
	tool,
	type AssistantContent,
	type ImagePart,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	type SystemModelMessage,
	type TextPart,
	type ToolCallPart,
	type ToolResultPart,
	type ToolSet,
} from "ai"
import type OpenAI from "openai"

import { REASONING_DETAILS_FIELD, type LLMClient } from "./llmClient.js"

// `ReasoningPart` isn't re-exported from "ai"; derive it from the exported
// assistant content union so we don't depend on a transitive package path.
type ReasoningPart = Extract<Exclude<AssistantContent, string>[number], { type: "reasoning" }>
import type { AxonModel } from "./models.js"
import type { ApiStreamChunk } from "./stream.js"

export interface AiSdkClientOptions {
	/** Resolved model entry (carries provider, baseUrl, apiKey, effort, …). */
	model: AxonModel
}

/**
 * LLM transport backed by the Vercel AI SDK. Serves any non-MatterAI provider
 * (Anthropic native `/v1/messages`, or any OpenAI-compatible endpoint) while
 * speaking the same OpenAI-shaped message/tool contract the agent loop uses —
 * translation happens entirely at this boundary. Auth is the provider's own
 * key (env var or settings), never the MatterAI token.
 */
export class AiSdkClient implements LLMClient {
	constructor(private readonly options: AiSdkClientOptions) {}

	async *createMessage(
		systemPrompt: string,
		messages: OpenAI.Chat.ChatCompletionMessageParam[],
		tools: OpenAI.Chat.ChatCompletionTool[],
		abortSignal?: AbortSignal,
	): AsyncGenerator<ApiStreamChunk> {
		const model = this.options.model
		const isAnthropic = model.provider === "anthropic"

		// Replay stored thinking blocks only on Anthropic, where they round-trip
		// with their signatures; other providers ignore the side-channel.
		const aiMessages = toModelMessages(messages, isAnthropic)
		if (isAnthropic) applyCacheBreakpoint(aiMessages)

		const aiTools = toAiTools(tools)
		const hasTools = Object.keys(aiTools).length > 0

		const result = streamText({
			model: this.resolveModel(),
			system: this.buildSystem(systemPrompt, isAnthropic),
			messages: aiMessages,
			...(hasTools ? { tools: aiTools, toolChoice: "auto" as const } : {}),
			maxOutputTokens: model.maxOutputTokens,
			// No `temperature`: the current Claude models reject sampling params.
			abortSignal,
			providerOptions: this.providerOptions(isAnthropic),
		})

		for await (const part of result.fullStream) {
			switch (part.type) {
				case "text-delta":
					if (part.text) yield { type: "text", text: part.text }
					break
				case "reasoning-delta":
					if (part.text) yield { type: "reasoning", text: part.text }
					break
				case "tool-call":
					yield {
						type: "native_tool_calls",
						toolCalls: [
							{
								id: part.toolCallId,
								type: "function",
								function: {
									name: part.toolName,
									arguments: JSON.stringify(part.input ?? {}),
								},
							},
						],
					}
					break
				case "finish":
					yield this.usageChunk(part.totalUsage)
					break
				case "error":
					throw asError(part.error)
			}
		}

		// Capture this turn's thinking blocks (with their provider signatures) so
		// the agent can stash them on the assistant message and replay them next
		// turn — required for interleaved thinking + tool use on the same model.
		const reasoning = collectReasoningParts((await result.response).messages)
		if (reasoning.length > 0) {
			yield { type: "reasoning_details", details: reasoning }
		}
	}

	/** Build the provider model handle for this request. */
	private resolveModel(): LanguageModel {
		const { provider, id, baseUrl, apiKey } = this.options.model
		switch (provider) {
			case "anthropic":
				// createAnthropic reads ANTHROPIC_API_KEY from the env when apiKey is absent.
				return createAnthropic(apiKey ? { apiKey } : {})(id)
			default: {
				// Any OpenAI-compatible endpoint (OpenRouter, Together, Groq, a local
				// server, even api.openai.com/v1). Adding a native provider package
				// (e.g. @ai-sdk/google) is a new `case` here.
				if (!baseUrl) {
					throw new Error(
						`Model "${id}" uses provider "${provider}" but no baseUrl is set. Add a "baseUrl" to its customModels entry in settings.json.`,
					)
				}
				return createOpenAICompatible({ name: provider ?? "openai-compatible", baseURL: baseUrl, apiKey })(id)
			}
		}
	}

	/** Cache the system prompt (and, on Anthropic, the tool list with it). */
	private buildSystem(systemPrompt: string, isAnthropic: boolean): string | SystemModelMessage {
		if (!isAnthropic) return systemPrompt
		return {
			role: "system",
			content: systemPrompt,
			providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
		}
	}

	/** Adaptive thinking + effort + reasoning replay for Anthropic; nothing otherwise. */
	private providerOptions(isAnthropic: boolean): SystemModelMessage["providerOptions"] {
		if (!isAnthropic) return undefined
		const model = this.options.model
		if (model.reasoning === false) return undefined
		return {
			anthropic: {
				thinking: { type: "adaptive", display: "summarized" },
				effort: model.effort ?? "high",
				sendReasoning: true,
			},
		}
	}

	private usageChunk(usage: LanguageModelUsage): ApiStreamChunk {
		const model = this.options.model
		const inputTokens = usage.inputTokens ?? 0
		const outputTokens = usage.outputTokens ?? 0
		return {
			type: "usage",
			inputTokens,
			outputTokens,
			cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
			reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
			totalCost: model.free ? 0 : inputTokens * model.inputPrice + outputTokens * model.outputPrice,
			inferenceProvider: model.provider,
		}
	}
}

/** Translate OpenAI-shaped function tools into the AI SDK's client-side tool set
 *  (no `execute` — the agent loop runs the tool and feeds the result back). */
function toAiTools(tools: OpenAI.Chat.ChatCompletionTool[]): ToolSet {
	const set: ToolSet = {}
	for (const t of tools) {
		if (t.type !== "function") continue
		set[t.function.name] = tool({
			description: t.function.description,
			inputSchema: jsonSchema((t.function.parameters as Record<string, unknown>) ?? { type: "object", properties: {} }),
		})
	}
	return set
}

/** Translate the OpenAI conversation history into AI SDK `ModelMessage`s.
 *  When `includeReasoning`, stored thinking blocks are prepended to each
 *  assistant turn (first, ahead of text/tool-call parts) for same-model replay. */
function toModelMessages(
	messages: OpenAI.Chat.ChatCompletionMessageParam[],
	includeReasoning: boolean,
): ModelMessage[] {
	// tool_result parts need the tool name, which OpenAI only carries on the
	// originating assistant tool_call — index it first.
	const toolNameById = new Map<string, string>()
	for (const message of messages) {
		if (message.role === "assistant" && message.tool_calls) {
			for (const call of message.tool_calls) {
				if (call.type === "function") toolNameById.set(call.id, call.function.name)
			}
		}
	}

	const out: ModelMessage[] = []
	for (const message of messages) {
		switch (message.role) {
			case "user": {
				if (typeof message.content === "string") {
					out.push({ role: "user", content: message.content })
					break
				}
				const parts: Array<TextPart | ImagePart> = []
				for (const part of message.content) {
					if (part.type === "text") {
						parts.push({ type: "text", text: part.text })
					} else if (part.type === "image_url") {
						const url = part.image_url.url
						const mediaType = /^data:([^;,]+)/.exec(url)?.[1]
						parts.push({ type: "image", image: new URL(url), ...(mediaType ? { mediaType } : {}) })
					}
				}
				out.push({ role: "user", content: parts })
				break
			}
			case "assistant": {
				const parts: Array<ReasoningPart | TextPart | ToolCallPart> = []
				if (includeReasoning) parts.push(...storedReasoningParts(message))
				const text = contentToText(message.content)
				if (text) parts.push({ type: "text", text })
				for (const call of message.tool_calls ?? []) {
					if (call.type !== "function") continue
					parts.push({
						type: "tool-call",
						toolCallId: call.id,
						toolName: call.function.name,
						input: safeParseJson(call.function.arguments),
					})
				}
				out.push({ role: "assistant", content: parts.length > 0 ? parts : "" })
				break
			}
			case "tool": {
				const result: ToolResultPart = {
					type: "tool-result",
					toolCallId: message.tool_call_id,
					toolName: toolNameById.get(message.tool_call_id) ?? "tool",
					output: { type: "text", value: contentToText(message.content) },
				}
				out.push({ role: "tool", content: [result] })
				break
			}
			// "system"/"developer"/"function" roles don't appear in OrbCode history
			// (the system prompt is passed separately) — ignore defensively.
		}
	}
	return out
}

/** Pull the reasoning parts out of the assistant message(s) the SDK assembled
 *  for this turn — these carry the provider signature needed to replay them. */
function collectReasoningParts(messages: ModelMessage[]): ReasoningPart[] {
	const parts: ReasoningPart[] = []
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const part of message.content) {
			if (part.type === "reasoning") parts.push(part)
		}
	}
	return parts
}

/** Read back the reasoning parts the agent stashed on a prior assistant turn. */
function storedReasoningParts(message: OpenAI.Chat.ChatCompletionMessageParam): ReasoningPart[] {
	const details = (message as unknown as Record<string, unknown>)[REASONING_DETAILS_FIELD]
	return Array.isArray(details) ? (details as ReasoningPart[]) : []
}

/** Tag the last message so Anthropic caches the conversation prefix up to here. */
function applyCacheBreakpoint(messages: ModelMessage[]): void {
	const last = messages[messages.length - 1]
	if (!last) return
	last.providerOptions = {
		...last.providerOptions,
		anthropic: { ...(last.providerOptions?.anthropic as object), cacheControl: { type: "ephemeral" } },
	}
}

/** Flatten OpenAI string-or-parts content down to plain text. */
function contentToText(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				part && typeof part === "object" && "text" in part ? String((part as { text?: unknown }).text ?? "") : "",
			)
			.join("")
	}
	return ""
}

function safeParseJson(raw: string | undefined): unknown {
	if (!raw) return {}
	try {
		return JSON.parse(raw)
	} catch {
		return {}
	}
}

function asError(error: unknown): Error {
	if (error instanceof Error) return error
	return new Error(typeof error === "string" ? error : JSON.stringify(error))
}
