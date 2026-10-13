import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"

import type { LLMClient } from "../src/api/llmClient.js"
import type { ApiStreamChunk } from "../src/api/stream.js"
import { Agent } from "../src/core/agent.js"
import { loadSessionById, type SessionData } from "../src/core/sessions.js"

type Tools = OpenAI.Chat.ChatCompletionTool[]

/** Replies with a fixed line and records the messages each turn sends to the model. */
class RecordingClient implements LLMClient {
	readonly requests: OpenAI.Chat.ChatCompletionMessageParam[][] = []
	constructor(private readonly reply: string) {}
	async warmup(): Promise<void> {}
	async *createMessage(
		_system: string,
		messages: OpenAI.Chat.ChatCompletionMessageParam[],
		_tools: Tools,
	): AsyncGenerator<ApiStreamChunk> {
		this.requests.push(messages.map((m) => ({ ...m })))
		yield { type: "text", text: this.reply }
		yield { type: "usage", inputTokens: 10, outputTokens: 1, totalCost: 0 }
	}
}

function makeAgent(client: LLMClient, cwd: string, resume?: SessionData): Agent {
	return new Agent({
		cwd,
		token: "",
		modelId: "zai/glm-5.3-flash",
		autoApproveEdits: true,
		autoApproveSafeCommands: true,
		client,
		resume,
		callbacks: {
			onEvent: () => {},
			requestApproval: async () => "yes",
			requestFollowup: async () => "ok",
		},
	})
}

// This is the mechanism `runHeadless` relies on for multi-turn headless mode:
// `--resume <id>` loads a saved SessionData and hands it to the Agent as `resume`,
// so a follow-up `-p` prompt continues the same session (same id, prior context)
// instead of starting a fresh agent that re-reads everything.
test("headless multi-turn: a resumed agent keeps its id and carries the prior turn's context", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-resume-"))
	process.env.MATTERAI_CONFIG_DIR = path.join(dir, ".config")

	// Turn 1: fresh agent, say something memorable, end the session (persists it).
	const first = new RecordingClient("noted")
	const a1 = makeAgent(first, dir)
	assert.equal(a1.hasSession, false)
	await a1.runTurn("remember the marker ZEBRA-42")
	await a1.endSession("other")
	const id = a1.taskId

	// The session was saved and can be loaded by id — exactly what `--resume <id>` does.
	const saved = loadSessionById(id)
	assert.ok(saved, "session should be saved and loadable by id")

	// Turn 2: resume that session and ask a follow-up.
	const second = new RecordingClient("done")
	const a2 = makeAgent(second, dir, saved)
	assert.equal(a2.taskId, id, "resumed agent keeps the same session id")
	await a2.runTurn("what was the marker?")

	// The resumed turn sent the first turn's conversation to the model, so the
	// model continues with context rather than re-deriving it — the whole point.
	const sent = JSON.stringify(second.requests.at(-1) ?? [])
	assert.ok(sent.includes("ZEBRA-42"), "resumed request should include the prior turn's content")
	assert.ok(sent.includes("what was the marker?"), "resumed request should include the new prompt")
})

test("headless: a fresh agent (no resume) starts with no prior messages", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-fresh-"))
	process.env.MATTERAI_CONFIG_DIR = path.join(dir, ".config")
	const client = new RecordingClient("done")
	const agent = makeAgent(client, dir)
	await agent.runTurn("hello")
	// Only the system + this one user prompt; no carried history.
	const sent = client.requests.at(-1) ?? []
	const userMessages = sent.filter((m) => m.role === "user")
	assert.equal(userMessages.length, 1)
})
