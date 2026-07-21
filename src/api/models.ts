// The Axon models served by the MatterAI backend. Ported from the
// Orbital extension's model registry (kilocode-models.ts).
/**
 * Reasoning-effort hint forwarded to providers that support it (e.g. Anthropic
 * `output_config.effort`). Ignored by providers that don't.
 */
export type ModelEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AxonModel {
  id: string;
  /** Model ID sent to the MatterAI gateway when it differs from the local selection ID. */
  gatewayModelId?: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsImages: boolean;
  /** USD per token */
  inputPrice: number;
  /** USD per token */
  outputPrice: number;
  free: boolean;
  /**
   * Which transport serves this model. Absent (or "matterai"/"axon") routes
   * through the MatterAI gateway (OpenAI `/chat/completions`). Any other value
   * (e.g. "anthropic", "openai-compatible") routes through the Vercel AI SDK.
   */
  provider?: string;
  /** Base URL for the "openai-compatible" provider (required for that provider). */
  baseUrl?: string;
  /** Explicit API key for AI-SDK providers; falls back to the provider's env var. */
  apiKey?: string;
  /** Reasoning effort hint for AI-SDK providers that support it. */
  effort?: ModelEffort;
  /** Whether to request reasoning/thinking from AI-SDK providers (default true). */
  reasoning?: boolean;
}

/** Providers served by the built-in MatterAI gateway rather than the AI SDK. */
const MATTERAI_PROVIDERS = new Set(["matterai", "axon"]);

/** True when the model should be served via the Vercel AI SDK transport. */
export function usesAiSdk(model: AxonModel): boolean {
  return Boolean(model.provider) && !MATTERAI_PROVIDERS.has(model.provider!);
}

/**
 * Well-known Claude models, served natively via the Anthropic provider (AI SDK,
 * `/v1/messages`). Built in so `--model claude-…` works without a settings.json
 * entry; auth is `ANTHROPIC_API_KEY` (or a per-model `apiKey`), never MatterAI.
 * Adaptive thinking + effort are on by default (see AiSdkClient); Haiku 4.5 sets
 * `reasoning: false` because it rejects the `effort` parameter.
 */
export const ANTHROPIC_MODELS: Record<string, AxonModel> = {
  "claude-opus-4-8": {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    description:
      "Anthropic's most capable Opus model — long-horizon agentic work, knowledge work, and coding.",
    contextWindow: 1_000_000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000005,
    outputPrice: 0.000025,
    free: false,
    provider: "anthropic",
  },
  "claude-opus-4-7": {
    id: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    description:
      "Previous-generation Opus — highly autonomous, strong on agentic, vision, and memory tasks.",
    contextWindow: 1_000_000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000005,
    outputPrice: 0.000025,
    free: false,
    provider: "anthropic",
  },
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    description: "Older Opus with adaptive thinking; 1M context.",
    contextWindow: 1_000_000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000005,
    outputPrice: 0.000025,
    free: false,
    provider: "anthropic",
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    description:
      "Anthropic's best balance of speed and intelligence; adaptive thinking, 1M context.",
    contextWindow: 1_000_000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000003,
    outputPrice: 0.000015,
    free: false,
    provider: "anthropic",
  },
  "claude-haiku-4-5": {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    description:
      "Fastest, most cost-effective Claude model for simple, latency-sensitive tasks.",
    contextWindow: 200_000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000001,
    outputPrice: 0.000005,
    free: false,
    provider: "anthropic",
    // Haiku 4.5 rejects the `effort` parameter, so don't send thinking/effort.
    reasoning: false,
  },
  "claude-fable-5": {
    id: "claude-fable-5",
    name: "Claude Fable 5",
    description:
      "Anthropic's most capable widely released model — most demanding reasoning and long-horizon work.",
    contextWindow: 1_000_000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.00001,
    outputPrice: 0.00005,
    free: false,
    provider: "anthropic",
  },
};

/**
 * Axon's own models (MatterAI gateway). These are the only models shown in
 * the TUI's `/model` picker and are the supported defaults. Third-party
 * providers (Anthropic, OpenAI-compatible) are registered under
 * `AXON_MODELS` for `-p --model` runs but are intentionally hidden from the
 * interactive picker for now.
 */
export const BUILTIN_AXON_MODELS: Record<string, AxonModel> = {
  "axon-eido-3-flash": {
    id: "axon-eido-3-flash",
    name: "Axon Eido 3 Flash (free)",
    description:
      "Axon Eido is a fast and low cost general purpose model for low-effort day-to-day tasks",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.0,
    outputPrice: 0.0,
    free: true,
  },
  "axon-eido-3-code-pro-200k": {
    id: "axon-eido-3-code-pro-200k",
    gatewayModelId: "axon-eido-3-code-pro",
    name: "Axon Eido 3 Pro (200K context)",
    description:
      "Axon Eido 3 Pro is the frontier Axon Code model for coding tasks, long running agents and general intelligence, fine-tuned on open source models.",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000003,
    outputPrice: 0.000009,
    free: false,
  },
  "axon-eido-3-code-pro-400k": {
    id: "axon-eido-3-code-pro-400k",
    gatewayModelId: "axon-eido-3-code-pro",
    name: "Axon Eido 3 Pro (400K context)",
    description:
      "Axon Eido 3 Pro is the frontier Axon Code model for coding tasks, long running agents and general intelligence, fine-tuned on open source models.",
    contextWindow: 400000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000003,
    outputPrice: 0.000009,
    free: false,
  },
  "axon-eido-3-code-mini-200k": {
    id: "axon-eido-3-code-mini-200k",
    gatewayModelId: "axon-eido-3-code-mini",
    name: "Axon Eido 3 Mini (200K context)",
    description:
      "Axon Eido 3 Mini is a general purpose super intelligent LLM coding model for high-effort day-to-day tasks",
    contextWindow: 200000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.0000015,
    outputPrice: 0.0000045,
    free: false,
  },
  "axon-eido-3-code-mini-400k": {
    id: "axon-eido-3-code-mini-400k",
    gatewayModelId: "axon-eido-3-code-mini",
    name: "Axon Eido 3 Mini (400K context)",
    description:
      "Axon Eido 3 Mini is a general purpose super intelligent LLM coding model for high-effort day-to-day tasks",
    contextWindow: 400000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.0000015,
    outputPrice: 0.0000045,
    free: false,
  },
};

/**
 * Full model registry, including third-party providers. The TUI picker uses
 * `BUILTIN_AXON_MODELS`; non-interactive `-p --model` runs resolve through
 * this map, so a custom 3P entry (e.g. `claude-opus-4-8` from settings.json)
 * still works headlessly.
 */
export const AXON_MODELS: Record<string, AxonModel> = {
  ...BUILTIN_AXON_MODELS,
  ...ANTHROPIC_MODELS,
};

export const DEFAULT_MODEL_ID = "axon-eido-3-code-mini-200k";

const EXTENDED_CONTEXT_PLANS = new Set(["proplus", "ultra"]);

/** Whether an account plan includes Axon's 400k context options. */
export function canUse400kContext(plan?: string): boolean {
  const normalizedPlan = plan?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
  return EXTENDED_CONTEXT_PLANS.has(normalizedPlan);
}

export function is400kAxonModel(modelId: string): boolean {
  return (
    modelId.startsWith("axon-eido-3-code-") && modelId.endsWith("-400k")
  );
}

export function get200kAxonFallback(modelId: string): string {
  return modelId.replace(/-400k$/, "-200k");
}

/** A model declared in settings.json; everything except the id is optional. */
export interface CustomModelConfig {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  /** USD per token */
  inputPrice?: number;
  /** USD per token */
  outputPrice?: number;
  /** Route via the AI SDK: "anthropic", "openai-compatible", etc. */
  provider?: string;
  /** Base URL for the "openai-compatible" provider. */
  baseUrl?: string;
  /** Explicit API key; falls back to the provider's standard env var. */
  apiKey?: string;
  /** Reasoning effort hint for providers that support it. */
  effort?: ModelEffort;
  /** Request reasoning/thinking from providers that support it (default true). */
  reasoning?: boolean;
}

/** Add user-defined models (from settings.json) to the registry. */
export function registerCustomModels(models: CustomModelConfig[]): void {
  for (const model of models) {
    if (!model || typeof model.id !== "string" || !model.id) continue;
    AXON_MODELS[model.id] = {
      id: model.id,
      name: model.name ?? model.id,
      description: model.description ?? "Custom model from settings.json",
      contextWindow: model.contextWindow ?? 200_000,
      maxOutputTokens: model.maxOutputTokens ?? 32_000,
      supportsImages: model.supportsImages ?? false,
      inputPrice: model.inputPrice ?? 0,
      outputPrice: model.outputPrice ?? 0,
      free: (model.inputPrice ?? 0) === 0 && (model.outputPrice ?? 0) === 0,
      provider: model.provider,
      baseUrl: model.baseUrl,
      apiKey: model.apiKey,
      effort: model.effort,
      reasoning: model.reasoning,
    };
  }
}

export function isValidAxonModel(modelId: string): boolean {
  return modelId in AXON_MODELS;
}

export function getModel(modelId: string): AxonModel {
  return AXON_MODELS[modelId] ?? AXON_MODELS[DEFAULT_MODEL_ID];
}

/** Resolve a local context-window option to the model ID understood by the gateway. */
export function getGatewayModelId(model: AxonModel): string {
  return model.gatewayModelId ?? model.id;
}
