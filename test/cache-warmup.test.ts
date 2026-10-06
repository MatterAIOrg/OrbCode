import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as http from "node:http"
import type { AddressInfo } from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"

import { AxonClient } from "../src/api/client.js"
import type { LLMClient } from "../src/api/llmClient.js"
import type { ApiStreamChunk } from "../src/api/stream.js"
import { Agent } from "../src/core/agent.js"

type Tools = OpenAI.Chat.ChatCompletionTool[]

/** Records the prefix (system prompt + tools) of every warmup and real request. */
class RecordingClient implements LLMClient {
	warmups: { system: string; tools: Tools }[] = []
	requests: { system: string; tools: Tools }[] = []

	async warmup(system: string, tools: Tools): Promise<void> {
		this.warmups.push({ system, tools })
	}

	async *createMessage(
		system: string,
		_messages: OpenAI.Chat.ChatCompletionMessageParam[],
		tools: Tools,
	): AsyncGenerator<ApiStreamChunk> {
		this.requests.push({ system, tools })
		yield { type: "text", text: "done" }
		yield { type: "usage", inputTokens: 100, outputTokens: 1, totalCost: 0 }
	}
}

function makeAgent(client: LLMClient) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-warmup-"))
	process.env.MATTERAI_CONFIG_DIR = path.join(dir, ".config")
	return new Agent({
		cwd: dir,
		token: "",
		modelId: "zai/glm-5.3-flash",
		autoApproveEdits: true,
		autoApproveSafeCommands: true,
		client,
		callbacks: {
			onEvent: () => {},
			requestApproval: async () => "yes",
			requestFollowup: async () => "ok",
		},
	})
}

test("warmup primes the exact system prompt and tools the first turn sends", async () => {
	const client = new RecordingClient()
	const agent = makeAgent(client)
	assert.equal(agent.hasSession, false)

	await agent.warmCache()
	await agent.runTurn("hello")

	assert.equal(client.warmups.length, 1)
	assert.equal(client.requests.length, 1)
	assert.equal(client.warmups[0].system, client.requests[0].system)
	assert.deepEqual(client.warmups[0].tools, client.requests[0].tools)
	assert.equal(agent.hasSession, true)
})

test("warmup is skipped once the conversation has started", async () => {
	const client = new RecordingClient()
	const agent = makeAgent(client)
	await agent.runTurn("hello")
	await agent.warmCache()
	assert.equal(client.warmups.length, 0)
})

test("warmup failures stay silent", async () => {
	const agent = makeAgent({
		warmup: async () => {
			throw new Error("gateway down")
		},
		createMessage: async function* () {},
	})
	await agent.warmCache()
})

test("AxonClient.warmup marks the request and caps output at one token", async () => {
	let received: { headers: http.IncomingHttpHeaders; body: any } | undefined
	const server = http.createServer((req, res) => {
		let raw = ""
		req.on("data", (chunk) => (raw += chunk))
		req.on("end", () => {
			received = { headers: req.headers, body: JSON.parse(raw) }
			res.writeHead(200, { "Content-Type": "text/event-stream" })
			res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "H" } }] })}\n\n`)
			res.end("data: [DONE]\n\n")
		})
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	try {
		const client = new AxonClient({
			token: "test-token",
			modelId: "zai/glm-5.3-flash",
			taskId: "task-123",
			baseUrl: `http://127.0.0.1:${port}/v1/`,
		})
		const tools: Tools = [
			{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } },
		]
		await client.warmup("SYSTEM", tools)

		assert.ok(received)
		assert.equal(received.headers["x-axoncode-warmup"], "1")
		assert.equal(received.headers["x-axoncode-taskid"], "task-123")
		assert.equal(received.body.max_tokens, 1)
		assert.equal(received.body.stream, true)
		assert.deepEqual(received.body.messages[0], { role: "system", content: "SYSTEM" })
		assert.deepEqual(received.body.tools, tools)
	} finally {
		server.close()
	}
})
