import OpenAI from "openai";

import { API_GATEWAY_PATH } from "../auth/auth.js";
import {
  DEFAULT_HEADERS,
  X_AXONCODE_TASKID,
  X_AXON_REPO,
  X_ORGANIZATIONID,
} from "./headers.js";
import { stripReasoningDetails, type LLMClient } from "./llmClient.js";
import { getModel } from "./models.js";
import type { ApiStreamChunk } from "./stream.js";

interface CompletionUsage {
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  total_tokens?: number;
  cost?: number;
  is_byok?: boolean;
  cost_details?: { upstream_inference_cost?: number };
}

export interface AxonClientOptions {
  token: string;
  modelId: string;
  taskId: string;
  organizationId?: string;
  /** git remote URL or workspace folder name, sent as X-AXON-REPO */
  repo?: string;
  /** custom OpenAI-compatible gateway; defaults to the MatterAI gateway derived from the token */
  baseUrl?: string;
}

export class AxonClient implements LLMClient {
  private client: OpenAI;
  private options: AxonClientOptions;

  constructor(options: AxonClientOptions) {
    this.options = options;
    this.client = new OpenAI({
      // Use the gateway URL directly. Do not rehost it through
      // getUrlFromToken — that helper rewrites any api.matterai.so host
      // onto the control plane, which would send inference to
      // api.matterai.so instead of the gateway at api2.matterai.so.
      // Per-model `baseUrl` overrides (e.g. local dev) still win.
      baseURL: options.baseUrl || API_GATEWAY_PATH,
      apiKey: options.token,
      defaultHeaders: DEFAULT_HEADERS,
    });
  }

  private requestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      [X_AXONCODE_TASKID]: this.options.taskId,
    };
    if (this.options.organizationId)
      headers[X_ORGANIZATIONID] = this.options.organizationId;
    if (this.options.repo) headers[X_AXON_REPO] = this.options.repo;
    return headers;
  }

  async *createMessage(
    systemPrompt: string,
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    tools: OpenAI.Chat.ChatCompletionTool[],
    abortSignal?: AbortSignal,
  ): AsyncGenerator<ApiStreamChunk> {
    const model = getModel(this.options.modelId);

    const requestOptions: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming =
      {
        model: model.id,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          ...stripReasoningDetails(messages),
        ],
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: model.maxOutputTokens,
      };
    if (tools.length > 0) {
      requestOptions.tools = tools;
      requestOptions.tool_choice = "auto";
      requestOptions.parallel_tool_calls = true;
    }

    const stream = await this.client.chat.completions.create(requestOptions, {
      headers: this.requestHeaders(),
      signal: abortSignal,
    });

    let lastUsage: CompletionUsage | undefined;
    let inferenceProvider: string | undefined;
    let fullContent = "";
    let isThinking = false;

    for await (const chunk of stream) {
      // The gateway may return an error object instead of throwing.
      if ("error" in chunk) {
        const error = (chunk as { error?: { message?: string; code?: number } })
          .error;
        const err = new Error(
          `Axon API Error ${error?.code ?? ""}: ${error?.message ?? "unknown error"}`,
        );
        (err as { status?: number }).status = error?.code;
        throw err;
      }

      if (
        "provider" in chunk &&
        typeof (chunk as { provider?: string }).provider === "string"
      ) {
        inferenceProvider = (chunk as { provider?: string }).provider;
      }

      if (chunk.usage) {
        lastUsage = chunk.usage as CompletionUsage;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        // Some backends re-send cumulative content; only forward the new suffix.
        let newText = delta.content;
        if (fullContent && newText.startsWith(fullContent)) {
          newText = newText.substring(fullContent.length);
        }
        fullContent = delta.content;

        if (newText) {
          // <think>…</think> blocks embedded in content are reasoning.
          if (newText.includes("<think>")) {
            isThinking = true;
          }
          if (
            newText.includes("<think>") ||
            newText.includes("</think>") ||
            isThinking
          ) {
            if (newText.includes("</think>")) {
              isThinking = false;
            }
            yield { type: "reasoning", text: newText };
          } else {
            yield { type: "text", text: newText };
          }
        }
      }

      // Models report reasoning under either key.
      const deltaRecord = delta as Record<string, unknown>;
      if (typeof deltaRecord.reasoning === "string" && deltaRecord.reasoning) {
        yield { type: "reasoning", text: deltaRecord.reasoning };
      }
      if (
        typeof deltaRecord.reasoning_content === "string" &&
        deltaRecord.reasoning_content
      ) {
        yield { type: "reasoning", text: deltaRecord.reasoning_content };
      }

      if (delta.tool_calls && delta.tool_calls.length > 0) {
        const validToolCalls = delta.tool_calls
          .filter((tc) => tc.function)
          .filter((tc) => {
            // First delta carries id + name; later deltas carry only
            // index + argument fragments. Drop pure placeholders.
            const hasValidId = tc.id !== null && tc.id !== undefined;
            const hasValidName = !!tc.function!.name;
            const hasArguments =
              typeof tc.function!.arguments === "string" &&
              tc.function!.arguments.length > 0;
            return hasValidId || hasValidName || hasArguments;
          })
          .map((tc) => ({
            index: tc.index,
            id: tc.id,
            type: tc.type,
            function: {
              name: tc.function!.name || "",
              arguments: tc.function!.arguments || "",
            },
          }));

        if (validToolCalls.length > 0) {
          yield { type: "native_tool_calls", toolCalls: validToolCalls };
        }
      }
    }

    if (lastUsage) {
      yield {
        type: "usage",
        inputTokens: lastUsage.prompt_tokens || 0,
        outputTokens: lastUsage.completion_tokens || 0,
        cacheReadTokens: lastUsage.prompt_tokens_details?.cached_tokens,
        reasoningTokens: lastUsage.completion_tokens_details?.reasoning_tokens,
        totalCost: this.getTotalCost(lastUsage),
        inferenceProvider,
      };
    }
  }

  private getTotalCost(lastUsage: CompletionUsage): number {
    const model = getModel(this.options.modelId);
    if (model.free) return 0;
    if (lastUsage.is_byok) {
      return lastUsage.cost_details?.upstream_inference_cost || 0;
    }
    return lastUsage.cost || 0;
  }
}
