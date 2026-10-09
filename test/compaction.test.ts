import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"

import type { LLMClient } from "../src/api/llmClient.js"
import type { ApiStreamChunk } from "../src/api/stream.js"
import { Agent } from "../src/core/agent.js"
import type { SessionData } from "../src/core/sessions.js"

// glm-5.3-flash: 232k-token window, auto-compaction at 80% (185.6k).
type Messages = OpenAI.Chat.ChatCompletionMessageParam[]

const tooLong = () =>
	Object.assign(new Error("This model's maximum context length is 232000 tokens. Please reduce the length of the messages."), {
		status: 400,
	})

/** Rough request size in tokens, as a provider would count it (4 chars/token). */
const requestTokens = (messages: Messages) => Math.ceil(JSON.stringify(messages).length / 4)

class Client implements LLMClient {
	requests: { messages: Messages; tools: number }[] = []
	constructor(private readonly answer: (messages: Messages, tools: number, n: number) => Array<ApiStreamChunk | Error>) {}
	async *createMessage(_s: string, messages: Messages, tools: OpenAI.Chat.ChatCompletionTool[]): AsyncGenerator<ApiStreamChunk> {
		this.requests.push({ messages: structuredClone(messages), tools: tools.length })
		for (const chunk of this.answer(messages, tools.length, this.requests.length)) {
			if (chunk instanceof Error) throw chunk
			yield chunk
		}
	}
	get summaries() {
		return this.requests.filter((r) => r.tools === 0)
	}
}

const summary = (): ApiStreamChunk[] => [
	{ type: "text", text: "SUMMARY" },
	{ type: "usage", inputTokens: 1000, outputTokens: 50, totalCost: 0 },
]
const final = (inputTokens = 5000): ApiStreamChunk[] => [
	{ type: "text", text: "done" },
	{ type: "usage", inputTokens, outputTokens: 10, totalCost: 0 },
]
const readCall = (inputTokens: number, file: string): ApiStreamChunk[] => [
	{
		type: "native_tool_calls",
		toolCalls: [
			{
				index: 0,
				id: `call_${file}_${inputTokens}`,
				type: "function",
				function: { name: "read_file", arguments: JSON.stringify({ files: [{ file_path: file, offset: null, limit: null }] }) },
			},
		],
	},
	{ type: "usage", inputTokens, outputTokens: 10, totalCost: 0 },
]

function makeAgent(client: LLMClient, resume?: SessionData) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-compact-"))
	process.env.MATTERAI_CONFIG_DIR = path.join(dir, ".config")
	fs.writeFileSync(path.join(dir, "small.txt"), "x".repeat(2000))
	// 1000 lines x 200 chars: read_file returns its 100k-char cap (~25k tokens).
	fs.writeFileSync(path.join(dir, "wide.txt"), Array.from({ length: 1000 }, (_, i) => `${i} ${"w".repeat(200)}`).join("\n"))
	const events: string[] = []
	const agent = new Agent({
		cwd: dir,
		token: "",
		modelId: "zai/glm-5.3-flash",
		autoApproveEdits: true,
		autoApproveSafeCommands: true,
		client,
		resume,
		callbacks: {
			onEvent: (event) => {
				if (event.type === "system" || event.type === "error") events.push(event.message)
			},
			requestApproval: async () => "yes",
			requestFollowup: async () => "ok",
		},
	})
	return { agent, events }
}

function session(contextTokens: number, opts: { turns?: number; charsPerReply?: number } = {}): SessionData {
	const messages: Messages = []
	for (let i = 0; i < (opts.turns ?? 4); i++) {
		messages.push({ role: "user", content: `<user_query>question ${i}</user_query>` })
		messages.push({ role: "assistant", content: `answer ${i} ${"z".repeat(opts.charsPerReply ?? 10)}` })
	}
	const now = new Date().toISOString()
	return {
		id: `s-${Math.random()}`,
		cwd: "/tmp",
		model: "zai/glm-5.3-flash",
		title: "t",
		createdAt: now,
		updatedAt: now,
		totalCost: 0,
		contextTokens,
		todos: "",
		messages,
	}
}

test("a resumed session past 80% compacts before its first request and keeps the new message verbatim", async () => {
	const client = new Client((_m, tools) => (tools === 0 ? summary() : final()))
	const { agent } = makeAgent(client, session(200_000))
	await agent.runTurn("now add tests")
	assert.equal(client.requests[0].tools, 0, "first request is the summary")
	const next = client.requests[1].messages
	assert.deepEqual(next.map((m) => m.role), ["user", "system", "user"])
	assert.match(String(next[0].content), /SUMMARY/)
	assert.match(String(next[1].content), /^# Environment/)
	assert.match(String(next[2].content), /now add tests\n\n<total_tokens>\d+ tokens left<\/total_tokens>$/)
})

test("tool output added since the last usage report counts toward the threshold", async () => {
	// 170k reported (73%), then read_file adds ~25k tokens: ~84% before the next step.
	let step = 0
	const client = new Client((_m, tools) => {
		if (tools === 0) return summary()
		step++
		return step === 1 ? readCall(170_000, "wide.txt") : final()
	})
	const { agent, events } = makeAgent(client, session(10_000))
	await agent.runTurn("read it")
	assert.equal(client.summaries.length, 1)
	assert.ok(events.some((e) => /Context is 8\d% full/.test(e)), events.join(" | "))
})

test("a failed auto-compaction is retried on the next turn", async () => {
	let attempts = 0
	const client = new Client((_m, tools) => {
		if (tools === 0) {
			attempts++
			return attempts === 1 ? [Object.assign(new Error("upstream hiccup"), { status: 400 })] : summary()
		}
		return final(210_000)
	})
	const { agent, events } = makeAgent(client, session(210_000))
	await agent.runTurn("one")
	assert.equal(attempts, 1)
	assert.ok(events.some((e) => /Auto-compaction failed/.test(e)))
	await agent.runTurn("two")
	assert.equal(attempts, 2)
	assert.ok(events.some((e) => /Conversation compacted/.test(e)))
})

test("a 'context too long' error compacts and retries the step instead of failing the turn", async () => {
	let overflowed = false
	const client = new Client((_m, tools) => {
		if (tools === 0) return summary()
		if (!overflowed) {
			overflowed = true
			return [tooLong()]
		}
		return final()
	})
	const { agent, events } = makeAgent(client, session(120_000))
	await agent.runTurn("go")
	assert.ok(events.some((e) => /no longer fits the model's context window/.test(e)), events.join(" | "))
	assert.equal(client.summaries.length, 1)
	// No transient-error retries of the oversized request, and no error surfaced.
	assert.ok(!events.some((e) => /Retrying/.test(e)))
	assert.ok(!events.some((e) => /maximum context length/.test(e)))
	assert.match(String(client.requests.at(-1)!.messages[0].content), /SUMMARY/)
})

test("a history already past the window still compacts: the summary request is trimmed to fit", async () => {
	// ~800k tokens of history on a 232k model (e.g. resumed from a bigger-window model).
	const WINDOW = 232_000
	const client = new Client((messages, tools) => {
		if (requestTokens(messages) > WINDOW) return [tooLong()]
		return tools === 0 ? summary() : final()
	})
	const { agent, events } = makeAgent(client, session(800_000, { turns: 8, charsPerReply: 400_000 }))
	await agent.runTurn("continue")
	const summaryRequest = client.summaries.find((r) => requestTokens(r.messages) <= WINDOW)
	assert.ok(summaryRequest, "a summary request fit the window")
	assert.ok(events.some((e) => /Conversation compacted/.test(e)), events.join(" | "))
	assert.ok(!events.some((e) => /maximum context length/.test(e)))
	// The turn's real request went out compacted.
	assert.ok(requestTokens(client.requests.at(-1)!.messages) < 10_000)
})

test("a provider window smaller than the catalog's: the summary budget shrinks until it fits", async () => {
	// Real upstream limit ~60k tokens while the catalog says 232k.
	const REAL_WINDOW = 60_000
	const client = new Client((messages, tools) => {
		if (requestTokens(messages) > REAL_WINDOW) return [tooLong()]
		return tools === 0 ? summary() : final()
	})
	const { agent, events } = makeAgent(client, session(300_000, { turns: 8, charsPerReply: 150_000 }))
	await agent.runTurn("continue")
	assert.ok(client.summaries.length >= 2, "retried with a smaller budget")
	assert.ok(events.some((e) => /Conversation compacted/.test(e)), events.join(" | "))
})

test("compaction still gives up cleanly when nothing fits", async () => {
	const client = new Client(() => [tooLong()])
	const { agent, events } = makeAgent(client, session(200_000))
	await agent.runTurn("go")
	assert.ok(events.some((e) => /Auto-compaction failed/.test(e)))
	assert.ok(events.some((e) => /maximum context length/.test(e)), "the original error is reported")
	// One proactive attempt (3 budgets) + one overflow-recovery attempt (3 budgets), then stop.
	assert.equal(client.summaries.length, 6)
})
