import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"

import type { LLMClient } from "../src/api/llmClient.js"
import type { ApiStreamChunk } from "../src/api/stream.js"
import { Agent } from "../src/core/agent.js"
import { loadSessionById } from "../src/core/sessions.js"

type Messages = OpenAI.Chat.ChatCompletionMessageParam[]

interface Step {
	tools?: { name: string; args: Record<string, unknown> }[]
	text?: string
}

/** Replays a script, one step per model call. */
class ScriptedClient implements LLMClient {
	private index = 0
	constructor(private readonly steps: Step[]) {}

	async *createMessage(_system: string, _messages: Messages): AsyncGenerator<ApiStreamChunk> {
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
		yield { type: "usage", inputTokens: 1000, outputTokens: 10, totalCost: 0 }
	}
}

function makeAgent(steps: Step[], resume?: ConstructorParameters<typeof Agent>[0]["resume"], dir?: string) {
	dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-rewind-"))
	process.env.MATTERAI_CONFIG_DIR = path.join(dir, ".config")
	const agent = new Agent({
		cwd: dir,
		token: "",
		modelId: "zai/glm-5.3-flash",
		autoApproveEdits: true,
		autoApproveSafeCommands: true,
		client: new ScriptedClient(steps),
		resume,
		callbacks: {
			onEvent: () => {},
			requestApproval: async () => "yes",
			requestFollowup: async () => "ok",
		},
	})
	return { agent, dir }
}

const write = (file: string, content: string) => ({ name: "file_write", args: { file_path: file, content } })
const edit = (file: string, from: string, to: string) => ({
	name: "file_edit",
	args: { file_path: file, old_string: from, new_string: to, replace_all: null },
})

test("each user turn is a rewind point that lists the files changed from then on", async () => {
	const { agent } = makeAgent([
		{ tools: [write("a.txt", "A1")] },
		{ text: "wrote a" },
		{ text: "just talking" },
		{ tools: [write("b.txt", "B1")] },
		{ text: "wrote b" },
	])
	await agent.runTurn("make a")
	await agent.runTurn("chat")
	await agent.runTurn("make b")

	const points = agent.rewindPoints
	assert.deepEqual(points.map((p) => p.text), ["make a", "chat", "make b"])
	assert.equal(points[0].changedFiles.length, 2)
	assert.equal(points[1].changedFiles.length, 1)
	assert.equal(points[2].changedFiles.length, 1)
})

test("rewinding both restores edited and created files and drops the later conversation", async () => {
	const { agent, dir } = makeAgent([
		{ tools: [write("a.txt", "original")] },
		{ text: "wrote a" },
		{ tools: [edit("a.txt", "original", "changed"), write("new.txt", "fresh")] },
		{ text: "edited" },
	])
	await agent.runTurn("make a")
	await agent.runTurn("change it")
	assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "changed")

	const second = agent.rewindPoints[1]
	const result = agent.rewind(second.id, "both")

	assert.equal(result.text, "change it")
	assert.equal(result.restoredFiles.length, 2)
	assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "original")
	assert.equal(fs.existsSync(path.join(dir, "new.txt")), false)
	assert.deepEqual(agent.rewindPoints.map((p) => p.text), ["make a"])
	assert.deepEqual(agent.displayTranscript.filter((e) => e.kind === "user").map((e) => e.text), ["make a"])

	const saved = loadSessionById(agent.taskId)!
	assert.equal(saved.messages.filter((m) => m.role === "user").length, 1)
	assert.equal(saved.checkpoints?.length, 1)
})

test("rewinding the conversation only leaves files alone but keeps them undoable from earlier turns", async () => {
	const { agent, dir } = makeAgent([
		{ tools: [write("a.txt", "A1")] },
		{ text: "ok" },
		{ tools: [write("b.txt", "B1")] },
		{ text: "ok" },
	])
	await agent.runTurn("make a")
	await agent.runTurn("make b")

	agent.rewind(agent.rewindPoints[1].id, "conversation")
	assert.equal(fs.readFileSync(path.join(dir, "b.txt"), "utf8"), "B1")
	assert.deepEqual(agent.rewindPoints.map((p) => p.text), ["make a"])

	// b.txt was created in a dropped turn; rewinding past turn 1 must still remove it.
	agent.rewind(agent.rewindPoints[0].id, "both")
	assert.equal(fs.existsSync(path.join(dir, "a.txt")), false)
	assert.equal(fs.existsSync(path.join(dir, "b.txt")), false)
})

test("rewinding code only keeps the conversation and tells the model about the restore", async () => {
	const { agent, dir } = makeAgent([{ tools: [write("a.txt", "A1")] }, { text: "ok" }])
	await agent.runTurn("make a")

	const result = agent.rewind(agent.rewindPoints[0].id, "code")
	assert.equal(result.restoredFiles.length, 1)
	assert.equal(fs.existsSync(path.join(dir, "a.txt")), false)
	assert.equal(agent.rewindPoints.length, 1)
	assert.equal(agent.rewindPoints[0].changedFiles.length, 0)
	assert.equal(agent.displayTranscript.filter((e) => e.kind === "user").length, 1)
	const saved = loadSessionById(agent.taskId)!
	const last = saved.messages.at(-1)!
	assert.match(String(last.content), /restored these files/)
})

test("rewinding to the first message resets the conversation so the next turn starts fresh", async () => {
	const { agent } = makeAgent([{ text: "hi" }])
	await agent.runTurn("hello")
	agent.rewind(agent.rewindPoints[0].id, "conversation")

	assert.deepEqual(agent.rewindPoints, [])
	assert.deepEqual(agent.displayTranscript, [])
	assert.equal(loadSessionById(agent.taskId)!.messages.length, 0)
})

test("rewind points survive a resume", async () => {
	const first = makeAgent([{ tools: [write("a.txt", "A1")] }, { text: "ok" }])
	await first.agent.runTurn("make a")
	const session = loadSessionById(first.agent.taskId)!

	const { agent, dir } = makeAgent([], session, first.dir)
	assert.deepEqual(agent.rewindPoints.map((p) => p.text), ["make a"])
	agent.rewind(agent.rewindPoints[0].id, "both")
	assert.equal(fs.existsSync(path.join(dir, "a.txt")), false)
})

test("rewinding to an unknown message is rejected", async () => {
	const { agent } = makeAgent([{ text: "hi" }])
	await agent.runTurn("hello")
	assert.throws(() => agent.rewind("nope", "both"), /no longer be rewound/)
})
