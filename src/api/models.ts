// The Axon models served by the MatterAI backend. Ported from the
// Orbital extension's model registry (kilocode-models.ts).
export interface AxonModel {
  id: string;
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
}

export const AXON_MODELS: Record<string, AxonModel> = {
  "axon-code-2-5-mini": {
    id: "axon-code-2-5-mini",
    name: "Axon Code 2.5 Mini (free)",
    description:
      "Axon Mini is an general purpose super intelligent LLM coding model for low-effort day-to-day tasks",
    contextWindow: 400000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.0000005,
    outputPrice: 0.0000015,
    free: true,
  },
  "axon-code-2-5-pro": {
    id: "axon-code-2-5-pro",
    name: "Axon Code 2.5 Pro",
    description:
      "Axon Code 2.5 Pro is the next-generation of Axon Code for coding tasks, currently in experimental stage.",
    contextWindow: 400000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000002,
    outputPrice: 0.000006,
    free: false,
  },
  "axon-eido-3-code-pro": {
    id: "axon-eido-3-code-pro",
    name: "Axon Eido 3 Pro",
    description:
      "Axon Eido 3 Pro is the frontier Axon Code model for coding tasks, long running agents and general intelligence, fine-tuned on open source models.",
    contextWindow: 400000,
    maxOutputTokens: 64000,
    supportsImages: true,
    inputPrice: 0.000003,
    outputPrice: 0.000009,
    free: false,
  },
};

export const DEFAULT_MODEL_ID = "axon-code-2-5-pro";

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
    };
  }
}

export function isValidAxonModel(modelId: string): boolean {
  return modelId in AXON_MODELS;
}

export function getModel(modelId: string): AxonModel {
  return AXON_MODELS[modelId] ?? AXON_MODELS[DEFAULT_MODEL_ID];
}
