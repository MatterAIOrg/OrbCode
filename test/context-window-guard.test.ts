import assert from "node:assert/strict"
import test from "node:test"
import type OpenAI from "openai"

import {
	ContextWindowGuardClient,
	estimateContextWindowInput,
	prepareContextWindowRequest,
} from "../src/api/contextWindowGuard.js"
import type { LLMClient } from "../src/api/llmClient.js"
import { BUILTIN_AXON_MODELS, type AxonModel } from "../src/api/models.js"
import type { ApiStreamChunk } from "../src/api/stream.js"

type Message = OpenAI.Chat.ChatCompletionMessageParam
type ToolDefinition = OpenAI.Chat.ChatCompletionTool

class RecordingClient implements LLMClient {
	calls: Array<{ systemPrompt: string; messages: Message[]; tools: ToolDefinition[] }> = []

	async *createMessage(
		systemPrompt: string,
		messages: Message[],
		tools: ToolDefinition[],
	): AsyncGenerator<ApiStreamChunk> {
		this.calls.push({ systemPrompt, messages, tools })
		yield { type: "text", text: "ok" }
	}
}

function tinyModel(contextWindow: number, maxOutputTokens: number): AxonModel {
	return {
		id: "tiny-test-model",
		name: "Tiny test model",
		description: "test",
		contextWindow,
		maxOutputTokens,
		supportsImages: false,
		inputPrice: 0,
		outputPrice: 0,
		free: true,
	}
}

test("derives exact 200k and 400k input budgets from the selected model", () => {
	const request = {
		systemPrompt: "system",
		messages: [{ role: "user", content: "hello" }] satisfies Message[],
		tools: [],
	}
	const model200k = BUILTIN_AXON_MODELS["axon-eido-3-code-mini-200k"]
	const model400k = BUILTIN_AXON_MODELS["axon-eido-3-code-mini-400k"]

	assert.equal(prepareContextWindowRequest({ model: model200k, ...request }).inputTokenBudget, 116_000)
	assert.equal(prepareContextWindowRequest({ model: model400k, ...request }).inputTokenBudget, 296_000)
})

test("fits a huge nested tool result before it reaches either provider", () => {
	const model = BUILTIN_AXON_MODELS["axon-eido-3-code-mini-200k"]
	const messages: Message[] = [
		{ role: "user", content: "Read the file" },
		{
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id: "read-1",
					type: "function",
					function: { name: "read_file", arguments: JSON.stringify({ file_path: "huge.txt" }) },
				},
			],
		},
		{ role: "tool", tool_call_id: "read-1", content: `BEGIN-${"x".repeat(600_000)}-END` },
	]

	const prepared = prepareContextWindowRequest({ model, systemPrompt: "system", messages, tools: [] })

	assert.equal(prepared.wasTruncated, true)
	assert.ok(prepared.estimatedInputTokens <= prepared.inputTokenBudget)
	assert.deepEqual(prepared.messages.map((message) => message.role), ["user", "assistant", "tool"])
	assert.match(String(prepared.messages[2].content), /content truncated/)
})

test("counts large native and MCP tool schemas in the same request budget", () => {
	const messages: Message[] = [{ role: "user", content: "hello" }]
	const small = estimateContextWindowInput({ systemPrompt: "system", messages, tools: [] })
	const large = estimateContextWindowInput({
		systemPrompt: "system",
		messages,
		tools: [
			{
				type: "function",
				function: {
					name: "large_mcp_tool",
					description: "schema description ".repeat(20_000),
					parameters: { type: "object", properties: {} },
				},
			},
		],
	})

	assert.ok(large > small + 200_000)
})

test("compacts schema prose without changing the tool argument contract", () => {
	const model = BUILTIN_AXON_MODELS["axon-eido-3-code-mini-200k"]
	const tools: ToolDefinition[] = [
		{
			type: "function",
			function: {
				name: "large_mcp_tool",
				description: "large tool description ".repeat(30_000),
				parameters: {
					type: "object",
					properties: {
						query: { type: "string", description: "query description ".repeat(30_000) },
					},
					required: ["query"],
				},
			},
		},
	]

	const prepared = prepareContextWindowRequest({
		model,
		systemPrompt: "system",
		messages: [{ role: "user", content: "search" }],
		tools,
	})
	const parameters = prepared.tools[0]?.function.parameters as {
		properties?: { query?: { type?: string } }
		required?: string[]
	}

	assert.equal(prepared.wasTruncated, true)
	assert.deepEqual(parameters.required, ["query"])
	assert.equal(parameters.properties?.query?.type, "string")
	assert.ok(prepared.estimatedInputTokens <= prepared.inputTokenBudget)
})

test("counts the complete serialized message, including provider-specific fields", () => {
	const messages = [
		{
			role: "assistant",
			content: "done",
			_provider_payload: "opaque".repeat(40_000),
		} as unknown as Message,
	]
	const withoutPayload = estimateContextWindowInput({
		systemPrompt: "system",
		messages: [{ role: "assistant", content: "done" }],
		tools: [],
	})
	const withPayload = estimateContextWindowInput({ systemPrompt: "system", messages, tools: [] })

	assert.ok(withPayload > withoutPayload + 200_000)
})

test("fits oversized initial attachment content without prior usage data", () => {
	const model = BUILTIN_AXON_MODELS["axon-eido-3-code-mini-200k"]
	const messages: Message[] = [
		{
			role: "user",
			content: `<attached_files><attached_file name="huge.txt">${"attachment ".repeat(80_000)}</attached_file></attached_files>`,
		},
	]

	const prepared = prepareContextWindowRequest({ model, systemPrompt: "system", messages, tools: [] })

	assert.equal(prepared.wasTruncated, true)
	assert.ok(prepared.estimatedInputTokens <= prepared.inputTokenBudget)
	assert.match(String(prepared.messages[0].content), /content truncated/)
})

test("guards compaction-shaped requests and retains the summary instruction", () => {
	const model = BUILTIN_AXON_MODELS["axon-eido-3-code-mini-200k"]
	const messages: Message[] = []
	for (let turn = 0; turn < 12; turn++) {
		messages.push({ role: "user", content: `old user ${turn} ${"x".repeat(20_000)}` })
		messages.push({ role: "assistant", content: `old assistant ${turn} ${"y".repeat(20_000)}` })
	}
	messages.push({ role: "user", content: "Summarize this conversation and respond with only the summary." })

	const prepared = prepareContextWindowRequest({ model, systemPrompt: "system", messages, tools: [] })

	assert.equal(prepared.wasTruncated, true)
	assert.ok(prepared.estimatedInputTokens <= prepared.inputTokenBudget)
	assert.match(String(prepared.messages.at(-1)?.content), /respond with only the summary/)
})

test("the final wrapper never invokes its delegate when no safe request can fit", async () => {
	const delegate = new RecordingClient()
	const guarded = new ContextWindowGuardClient(delegate, tinyModel(600, 500))
	const stream = guarded.createMessage("system", [{ role: "user", content: "hello" }], [])

	await assert.rejects(stream.next(), /No LLM call was made/)
	assert.equal(delegate.calls.length, 0)
})

test("the final wrapper passes only fitted content to the transport", async () => {
	const delegate = new RecordingClient()
	const model = tinyModel(20_000, 2_000)
	const guarded = new ContextWindowGuardClient(delegate, model)
	const stream = guarded.createMessage("system", [{ role: "user", content: "large input ".repeat(100_000) }], [])

	for await (const _chunk of stream) {
		// Drain the generator so the lazy guard and delegate execute.
	}

	assert.equal(delegate.calls.length, 1)
	const [call] = delegate.calls
	assert.ok(estimateContextWindowInput(call) <= 16_000)
})
