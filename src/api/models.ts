// The Axon models served by the MatterAI backend. Ported from the
// Orbital extension's model registry (kilocode-models.ts).
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/**
 * Read the currently selected model id from disk without triggering the full
 * settings-load side effects (env application, custom-model registration).
 * Used by fetchDynamicModels to avoid pruning the user's selection.
 */
function loadSettingsModel(): string {
  try {
    const dir = process.env.MATTERAI_CONFIG_DIR || path.join(os.homedir(), ".orbcode")
    const raw = fs.readFileSync(path.join(dir, "config.json"), "utf8")
    const parsed = JSON.parse(raw)
    return typeof parsed.model === "string" ? parsed.model : ""
  } catch {
    return ""
  }
}

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
  /** Human-readable pricing shown when the gateway chooses the billable model dynamically. */
  pricingLabel?: string;
  /** Provider icon URL from the backend catalog. The TUI shows a text badge instead (terminals can't render SVGs). */
  iconUrl?: string;
  /** Plan-pool cost multiplier from the backend catalog (e.g. 4 = 4x plan cost). */
  costMultiplier?: number;
  /** True when the backend catalog marks this model as the free-plan model. */
  freePlan?: boolean;
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
 * The OSS models served through the MatterAI gateway. These are the only
 * models shown in the TUI's `/model` picker and are the supported defaults.
 * Third-party providers (Anthropic, OpenAI-compatible) are registered under
 * `AXON_MODELS` for `-p --model` runs but are intentionally hidden from the
 * interactive picker for now.
 */
export const BUILTIN_AXON_MODELS: Record<string, AxonModel> = {
  "meta/muse-spark-1.3-contributor": {
    id: "meta/muse-spark-1.3-contributor",
    name: "Muse Spark 1.3 Contributor",
    description:
      "Meta Muse Spark 1.3 Contributor is an open general purpose model for everyday coding tasks.",
    contextWindow: 232000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.0000001,
    outputPrice: 0.0000002,
    free: false,
  },
  "deepseek/deepseek-v4-flash-0731": {
    id: "deepseek/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash",
    description:
      "DeepSeek V4 Flash is a fast, low cost open model for low-effort day-to-day coding tasks.",
    contextWindow: 232000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.00000014,
    outputPrice: 0.00000028,
    free: false,
  },
  "zai/glm-5.3": {
    id: "zai/glm-5.3",
    name: "GLM 5.3",
    description:
      "GLM 5.3 is Z.ai's frontier open model for complex coding tasks and long running agents.",
    contextWindow: 232000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.0000014,
    outputPrice: 0.0000044,
    free: false,
  },
  "zai/glm-5.3-flash": {
    id: "zai/glm-5.3-flash",
    name: "GLM 5.3 Flash",
    description:
      "GLM 5.3 Flash is a fast, low cost open model for everyday coding tasks.",
    contextWindow: 232000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.00000015,
    outputPrice: 0.0000005,
    free: false,
  },
  "gpt-5.6-luna": {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    description:
      "GPT-5.6 Luna is a fast, low cost open model for everyday coding tasks.",
    contextWindow: 232000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.0000002,
    outputPrice: 0.0000012,
    free: false,
  },
  "gpt-5.6-sol": {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    description:
      "GPT-5.6 Sol is an open reasoning model for complex coding tasks and long running agents.",
    contextWindow: 232000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000005,
    outputPrice: 0.00003,
    free: false,
  },
  "gemini-3.8-flash": {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    description:
      "Gemini 3.8 Flash is a fast, low cost model by Google for everyday coding tasks.",
    contextWindow: 232000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.00000075,
    outputPrice: 0.00000375,
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

export const DEFAULT_MODEL_ID = "zai/glm-5.3-flash";

/**
 * Model ids owned by the static catalog or a previous dynamic fetch. A
 * successful (non-empty) catalog fetch prunes any of these the backend no
 * longer serves, so retired models disappear from the picker instead of
 * lingering next to their replacement.
 */
const managedModelIds = new Set<string>(Object.keys(BUILTIN_AXON_MODELS));

/**
 * Model ids in backend catalog order (the order `/v1/models` returns, i.e.
 * `sortOrder` then `created`). Index 0 is the default for paid plans; the entry
 * flagged `freePlan` is the default for free plans. Empty until a successful
 * dynamic fetch, so the static fallback is used before then.
 */
let catalogOrder: string[] = [];

const EXTENDED_CONTEXT_PLANS = new Set(["proplus", "ultra"]);
const LUMEN_MODEL_PLANS = new Set(["proplus", "ultra"]);
const EIDO_PRO_MODEL_PLANS = new Set(["pro", "proplus", "ultra"]);
const EIDO_BASE_MODEL_PLANS = new Set(["pro", "proplus", "ultra"]);

function normalizePlan(plan?: string): string {
  return plan?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "";
}

/** Whether an account plan includes Axon's 400k context options. */
export function canUse400kContext(plan?: string): boolean {
  return EXTENDED_CONTEXT_PLANS.has(normalizePlan(plan));
}

/** Whether an account plan includes the Axon Lumen models. */
export function canUseLumenModels(plan?: string): boolean {
  return LUMEN_MODEL_PLANS.has(normalizePlan(plan));
}

/** Whether an account plan includes the Axon Eido 3 Pro models. */
export function canUseEidoProModels(plan?: string): boolean {
  return EIDO_PRO_MODEL_PLANS.has(normalizePlan(plan));
}

/** Whether an account plan includes the Axon Eido 3.2 Code (base) models. */
export function canUseEidoBaseModels(plan?: string): boolean {
  return EIDO_BASE_MODEL_PLANS.has(normalizePlan(plan));
}

export function is400kAxonModel(modelId: string): boolean {
  return (
    (modelId.startsWith("axon-auto-") ||
      modelId.startsWith("axon-eido-3.2-code-") ||
      modelId.startsWith("axon-eido-3.2-flash-") ||
      modelId.startsWith("axon-lumen-4-code-")) &&
    modelId.endsWith("-400k")
  );
}

export function isLumenAxonModel(modelId: string): boolean {
  return modelId.startsWith("axon-lumen-");
}

export function isEidoProAxonModel(modelId: string): boolean {
  return modelId.startsWith("axon-eido-3.2-code-pro");
}

export function isEidoBaseAxonModel(modelId: string): boolean {
  return (
    (modelId === "axon-eido-3.2-code-232k" || modelId === "axon-eido-3.2-code-400k") &&
    !isEidoProAxonModel(modelId)
  );
}

/**
 * Return the 232K (default) sibling of an extended-context (400K) Axon model id.
 * Auto, Eido 3.2, and Lumen all share the same two-window convention now.
 */
export function get232kAxonFallback(modelId: string): string {
  // The default-tier Flash option uses the bare id (no "-232k" suffix), so the
  // generic -400k → -232k rewrite would point at a non-existent model.
  if (modelId === "axon-eido-3.2-flash-400k") return "axon-eido-3.2-flash";
  return modelId.replace(/-400k$/, "-232k");
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

/** Whether an AxonCode plan string is the free tier (a missing plan counts as free). */
export function isFreePlan(plan?: string): boolean {
  const normalized = plan?.trim().toLowerCase() ?? "";
  return normalized === "" || normalized === "free";
}

/**
 * Default model for the live catalog: free accounts get the entry the backend
 * flags `freePlan`, every other plan gets the first entry the backend serves
 * (index 0, ordered by the catalog's `sortOrder`). Falls back to
 * DEFAULT_MODEL_ID until a catalog fetch succeeds.
 */
export function getDefaultModelId(plan?: string): string {
  if (catalogOrder.length === 0) return DEFAULT_MODEL_ID;
  if (isFreePlan(plan)) {
    const freeModelId = catalogOrder.find(
      (id) => BUILTIN_AXON_MODELS[id]?.freePlan === true,
    );
    if (freeModelId) return freeModelId;
  }
  return catalogOrder[0]!;
}

/** Resolve a local context-window option to the model ID understood by the gateway. */
export function getGatewayModelId(model: AxonModel): string {
  return model.gatewayModelId ?? model.id;
}

/**
 * Fetches dynamic models from the MatterAI backend (/v1/models) and registers them
 * into BUILTIN_AXON_MODELS and AXON_MODELS so the model picker and agent loops can
 * dynamically use newly added models without hardcoding.
 */
export async function fetchDynamicModels(
  token?: string,
): Promise<Record<string, AxonModel>> {
  try {
    const { getUrlFromToken } = await import("../auth/auth.js");
    const targetUrl = token
      ? getUrlFromToken("https://api.matterai.so/v1/models", token)
      : "https://api.matterai.so/v1/models";

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const res = await fetch(targetUrl, {
      headers,
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) {
      return BUILTIN_AXON_MODELS;
    }

    const json = (await res.json()) as any;
    const items = Array.isArray(json?.data) ? json.data : [];

    const fetched: AxonModel[] = [];
    for (const item of items) {
      if (!item?.id || typeof item.id !== "string" || item.id.startsWith("axon-")) {
        continue;
      }
      fetched.push({
        id: item.id,
        name: item.name || item.id,
        description: item.description || `${item.name || item.id} open model`,
        contextWindow: item.context_length || 232000,
        maxOutputTokens: item.max_output_length || 64000,
        supportsImages: Array.isArray(item.input_modalities)
          ? item.input_modalities.includes("image")
          : true,
        inputPrice:
          typeof item.pricing?.prompt === "string"
            ? parseFloat(item.pricing.prompt) || 0
            : typeof item.pricing?.prompt === "number"
              ? item.pricing.prompt
              : 0,
        outputPrice:
          typeof item.pricing?.completion === "string"
            ? parseFloat(item.pricing.completion) || 0
            : typeof item.pricing?.completion === "number"
              ? item.pricing.completion
              : 0,
        free: false,
        freePlan: item.freePlan === true,
        iconUrl: typeof item.iconUrl === "string" ? item.iconUrl : undefined,
        costMultiplier:
          typeof item.costMultiplier === "number" ? item.costMultiplier : undefined,
      });
    }

    // Reconcile only when the backend returned a usable catalog — an empty or
    // failed response must never wipe the offline fallback. Retired models
    // (e.g. a version bump the static fallback still lists) are pruned so they
    // don't linger in the picker next to their replacement. The user's current
    // selection is never pruned — a transient backend gap shouldn't swap it.
    if (fetched.length > 0) {
      catalogOrder = fetched.map((model) => model.id);
      const fetchedIds = new Set(fetched.map((model) => model.id));
      const currentModel = loadSettingsModel()
      for (const id of managedModelIds) {
        if (id === DEFAULT_MODEL_ID || fetchedIds.has(id) || id === currentModel) continue;
        delete BUILTIN_AXON_MODELS[id];
        delete AXON_MODELS[id];
      }
      managedModelIds.clear();
      for (const model of fetched) {
        managedModelIds.add(model.id);
        BUILTIN_AXON_MODELS[model.id] = model;
        AXON_MODELS[model.id] = model;
      }
    }
    return BUILTIN_AXON_MODELS;
  } catch {
    return BUILTIN_AXON_MODELS;
  }
}
