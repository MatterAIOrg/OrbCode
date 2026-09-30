import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"

import type { LLMClient } from "../src/api/llmClient.js"
import type { ApiStreamChunk } from "../src/api/stream.js"
import { Agent } from "../src/core/agent.js"

type Messages = OpenAI.Chat.ChatCompletionMessageParam[]

interface ScriptedStep {
	/** tool calls to emit, or none for a final text answer */
	tools?: { name: string; args: Record<string, unknown> }[]
	text?: string
	/** reported context size for this step */
	inputTokens?: number
}

/** A model that replays a script and records every request it receives. */
class ScriptedClient implements LLMClient {
	requests: { messages: Messages; toolCount: number }[] = []
	private index = 0
	constructor(
		private readonly steps: ScriptedStep[],
		private readonly summary = "SUMMARY-OF-WORK",
	) {}

	async *createMessage(
		_system: string,
		messages: Messages,
		tools: OpenAI.Chat.ChatCompletionTool[],
	): AsyncGenerator<ApiStreamChunk> {
		this.requests.push({ messages: structuredClone(messages), toolCount: tools.length })
		// Compaction requests are tool-less; answer them without consuming the script.
		if (tools.length === 0) {
			yield { type: "text", text: this.summary }
			yield { type: "usage", inputTokens: 1000, outputTokens: 50, totalCost: 0 }
			return
		}
		const step = this.steps[this.index++] ?? { text: "done" }
		if (step.tools) {
			yield {
				type: "native_tool_calls",
				toolCalls: step.tools.map((tool, i) => ({
					index: i,
					id: `call_${this.index}_${i}`,
					type: "function" as const,
					function: { name: tool.name, arguments: JSON.stringify(tool.args) },
				})),
			}
		} else {
			yield { type: "text", text: step.text ?? "done" }
		}
		yield { type: "usage", inputTokens: step.inputTokens ?? 1000, outputTokens: 10, totalCost: 0 }
	}
}

function makeAgent(client: LLMClient) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-agent-"))
	process.env.MATTERAI_CONFIG_DIR = path.join(dir, ".config")
	fs.writeFileSync(
		path.join(dir, "big.txt"),
		Array.from({ length: 200 }, (_, i) => `line number ${i} with some padding text`).join("\n"),
	)
	const events: string[] = []
	const agent = new Agent({
		cwd: dir,
		token: "",
		modelId: "zai/glm-5.3-flash",
		autoApproveEdits: true,
		autoApproveSafeCommands: true,
		client,
		callbacks: {
			onEvent: (event) => {
				if (event.type === "system") events.push(event.message)
			},
			requestApproval: async () => "yes",
			requestFollowup: async () => "ok",
		},
	})
	return { agent, dir, events }
}

const READ_BIG = { name: "read_file", args: { files: [{ file_path: "big.txt", offset: null, limit: null }] } }
const readRegion = (i: number) => ({
	name: "read_file",
	args: { files: [{ file_path: "big.txt", offset: i + 1, limit: 200 }] },
})

function toolTexts(messages: Messages): string[] {
	return messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : ""))
}

test("identical repeated calls with identical output get a loop warning on the 3rd", async () => {
	const client = new ScriptedClient([{ tools: [READ_BIG] }, { tools: [READ_BIG] }, { tools: [READ_BIG] }, { text: "done" }])
	const { agent } = makeAgent(client)
	await agent.runTurn("look at the file")
	const last = toolTexts(client.requests.at(-1)!.messages)
	assert.equal(last.length, 3)
	assert.doesNotMatch(last[0], /identical/)
	assert.doesNotMatch(last[1], /identical/)
	assert.match(last[2], /3rd identical read_file call/)
})

test("an edit between repeats resets the loop counter", async () => {
	const edit = {
		name: "file_edit",
		args: { file_path: "big.txt", old_string: "line number 0 with", new_string: "line number 0 WITH", replace_all: null },
	}
	const edit2 = {
		name: "file_edit",
		args: { file_path: "big.txt", old_string: "line number 0 WITH", new_string: "line number 0 with", replace_all: null },
	}
	const client = new ScriptedClient([
		{ tools: [READ_BIG] },
		{ tools: [READ_BIG] },
		{ tools: [edit] },
		{ tools: [READ_BIG] },
		{ tools: [edit2] },
		{ tools: [READ_BIG] },
		{ text: "done" },
	])
	const { agent } = makeAgent(client)
	await agent.runTurn("go")
	for (const text of toolTexts(client.requests.at(-1)!.messages)) assert.doesNotMatch(text, /identical/)
})

test("stale bulky tool results are stubbed once context is large; recent ones stay verbatim", async () => {
	// 232k window: 100k input tokens is past the 40% prune trigger.
	const steps: ScriptedStep[] = Array.from({ length: 12 }, (_, i) => ({ tools: [readRegion(i)], inputTokens: 100_000 }))
	steps.push({ text: "done", inputTokens: 100_000 })
	const client = new ScriptedClient(steps)
	const { agent } = makeAgent(client)
	await agent.runTurn("read a lot")
	const texts = toolTexts(client.requests.at(-1)!.messages)
	assert.equal(texts.length, 12)
	const stubbed = texts.filter((t) => t.startsWith("[Earlier read_file result"))
	assert.ok(stubbed.length >= 6, `expected at least one batch stubbed, got ${stubbed.length}`)
	// The four most recent results are never stubbed.
	for (const t of texts.slice(-4)) assert.doesNotMatch(t, /^\[Earlier/)
	// Stubbed results are the oldest ones, contiguous from the start.
	const firstFull = texts.findIndex((t) => !t.startsWith("[Earlier"))
	assert.equal(stubbed.length, firstFull)
})

test("small contexts are never pruned", async () => {
	const steps: ScriptedStep[] = Array.from({ length: 10 }, (_, i) => ({ tools: [readRegion(i)], inputTokens: 5_000 }))
	steps.push({ text: "done", inputTokens: 5_000 })
	const client = new ScriptedClient(steps)
	const { agent } = makeAgent(client)
	await agent.runTurn("read a lot")
	for (const t of toolTexts(client.requests.at(-1)!.messages)) assert.doesNotMatch(t, /^\[Earlier/)
})

test("history is auto-compacted when the context nears the window, and the turn continues", async () => {
	const client = new ScriptedClient([
		{ tools: [readRegion(0)], inputTokens: 10_000 },
		{ tools: [readRegion(1)], inputTokens: 200_000 }, // 86% of 232k
		{ tools: [readRegion(2)], inputTokens: 5_000 },
		{ text: "all done", inputTokens: 5_000 },
	])
	const { agent, events } = makeAgent(client)
	await agent.runTurn("long job")
	assert.ok(events.some((e) => /compacting the conversation/.test(e)))
	assert.ok(events.some((e) => /Conversation compacted/.test(e)))
	const compactRequests = client.requests.filter((r) => r.toolCount === 0)
	assert.equal(compactRequests.length, 1)
	// The request after compaction starts from a single summary message.
	const afterIdx = client.requests.findIndex((r) => r.toolCount === 0) + 1
	const after = client.requests[afterIdx].messages
	assert.equal(after.length, 1)
	assert.match(String(after[0].content), /SUMMARY-OF-WORK/)
	assert.match(String(after[0].content), /Continue the work described above/)
})

test("a failing auto-compaction is reported once and does not derail the turn", async () => {
	class FailingSummaryClient extends ScriptedClient {
		summaryCalls = 0
		async *createMessage(
			system: string,
			messages: Messages,
			tools: OpenAI.Chat.ChatCompletionTool[],
		): AsyncGenerator<ApiStreamChunk> {
			if (tools.length === 0) {
				this.summaryCalls++
				throw Object.assign(new Error("bad request"), { status: 400 })
			}
			yield* super.createMessage(system, messages, tools)
		}
	}
	const client = new FailingSummaryClient([
		{ tools: [readRegion(0)], inputTokens: 200_000 },
		{ tools: [readRegion(1)], inputTokens: 200_000 },
		{ text: "finished", inputTokens: 200_000 },
	])
	const { agent, events } = makeAgent(client)
	await agent.runTurn("job")
	assert.equal(client.summaryCalls, 1)
	assert.equal(events.filter((e) => /Auto-compaction failed/.test(e)).length, 1)
})

test("whitespace-only content before a tool call is not kept as an assistant message", async () => {
	class BlankThenTool extends ScriptedClient {
		private calls = 0
		async *createMessage(
			system: string,
			messages: Messages,
			tools: OpenAI.Chat.ChatCompletionTool[],
		): AsyncGenerator<ApiStreamChunk> {
			if (this.calls++ === 0) {
				this.requests.push({ messages: structuredClone(messages), toolCount: tools.length })
				yield { type: "text", text: "\n\n" }
				yield {
					type: "native_tool_calls",
					toolCalls: [{ index: 0, id: "c1", type: "function", function: { name: READ_BIG.name, arguments: JSON.stringify(READ_BIG.args) } }],
				}
				yield { type: "usage", inputTokens: 1000, outputTokens: 5, totalCost: 0 }
				return
			}
			yield* super.createMessage(system, messages, tools)
		}
	}
	const client = new BlankThenTool([{ text: "All done." }])
	const { agent } = makeAgent(client)
	await agent.runTurn("go")
	const assistantTexts = agent.displayTranscript.filter((e) => e.kind === "assistant").map((e) => (e as { text: string }).text)
	assert.deepEqual(assistantTexts, ["All done."])
	const sentAssistant = client.requests.at(-1)!.messages.find((m) => m.role === "assistant")!
	assert.equal(sentAssistant.content, null)
})
