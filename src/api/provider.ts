import { AiSdkClient } from "./aiSdkClient.js"
import { AxonClient, type AxonClientOptions } from "./client.js"
import { ContextWindowGuardClient } from "./contextWindowGuard.js"
import type { LLMClient } from "./llmClient.js"
import { getModel, usesAiSdk } from "./models.js"

/**
 * Pick the transport for a model. MatterAI/Axon models keep using `AxonClient`
 * (OpenAI `/chat/completions` against the gateway, with all its auth/headers/
 * cost handling); anything declaring another `provider` goes through the Vercel
 * AI SDK. Both implement `LLMClient`, so the agent loop is unaffected.
 */
export function createLLMClient(options: AxonClientOptions): LLMClient {
	const model = getModel(options.modelId)
	const client = usesAiSdk(model) ? new AiSdkClient({ model }) : new AxonClient(options)
	return new ContextWindowGuardClient(client, model)
}
