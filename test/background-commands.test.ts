import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { executeCommand } from "../src/tools/executors/executeCommand.js"
import { checkBackground } from "../src/tools/executors/checkBackground.js"
import { killBackground } from "../src/tools/executors/killBackground.js"
import {
	getBackgroundCommand,
	killBackgroundCommandsFor,
	listBackgroundCommands,
	readBackgroundOutputTail,
	resetBackgroundCommands,
	subscribeBackgroundCommands,
	takeFinishedBackgroundCommands,
} from "../src/tools/executors/backgroundCommands.js"

const context = () => ({ cwd: os.tmpdir(), token: "", getTodos: () => "", setTodos: () => {}, signal: undefined })

/** Extract the bg command id from the tool result text. */
function extractId(text: string): string {
	const match = /id: (bg_[\w.]+)/.exec(text)
	assert.ok(match, `no background id in: ${text}`)
	return match[1]
}

/** Wait until the background command leaves the running state (or timeout). */
async function waitForCompletion(id: string, timeoutMs = 10_000): Promise<void> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const cmd = getBackgroundCommand(id)
		assert.ok(cmd, "command disappeared from registry")
		if (cmd.status !== "running") return
		await new Promise((r) => setTimeout(r, 100))
	}
	assert.fail(`background command ${id} did not finish within ${timeoutMs}ms`)
}

test("background command returns an id and pid immediately", async () => {
	try {
		const res = await executeCommand({ command: "echo hi", background: true }, context())
		assert.equal(res.isError, undefined)
		assert.match(res.text, /Background command started/)
		assert.match(res.text, /id: bg_/)
		assert.match(res.text, /pid: \d+/)
	} finally {
		resetBackgroundCommands()
	}
})

test("completed background command reports exit code and output", async () => {
	try {
		const start = await executeCommand({ command: "echo hello-bg", background: true }, context())
		const id = extractId(start.text)
		await waitForCompletion(id)

		const res = await checkBackground({ id }, context())
		assert.match(res.text, /Status: completed/)
		assert.match(res.text, /Exit code: 0/)
		assert.match(res.text, /hello-bg/)
	} finally {
		resetBackgroundCommands()
	}
})

test("failed background command reports non-zero exit code", async () => {
	try {
		const start = await executeCommand({ command: "exit 3", background: true }, context())
		const id = extractId(start.text)
		await waitForCompletion(id)

		const res = await checkBackground({ id }, context())
		assert.match(res.text, /Status: failed/)
		assert.match(res.text, /Exit code: 3/)
	} finally {
		resetBackgroundCommands()
	}
})

test("running background command shows partial output", { skip: process.platform === "win32" }, async () => {
	try {
		const start = await executeCommand({ command: "echo early; sleep 5; echo late", background: true }, context())
		const id = extractId(start.text)

		// Wait for the early line to be flushed to the output file.
		let sawPartial = false
		for (let i = 0; i < 50 && !sawPartial; i++) {
			await new Promise((r) => setTimeout(r, 100))
			const res = await checkBackground({ id }, context())
			if (/Status: running/.test(res.text) && /early/.test(res.text)) sawPartial = true
		}
		assert.ok(sawPartial, "partial output was never visible while running")

		const killed = await killBackground({ id }, context())
		assert.notEqual(killed.isError, true)
		await waitForCompletion(id)
		const res = await checkBackground({ id }, context())
		assert.match(res.text, /Status: killed/)
	} finally {
		resetBackgroundCommands()
	}
})

test("check_background with unknown id fails", async () => {
	const res = await checkBackground({ id: "bg_nonexistent" }, context())
	assert.equal(res.isError, true)
	assert.match(res.text, /No background command found/)
})

test("check_background without id fails", async () => {
	const res = await checkBackground({}, context())
	assert.equal(res.isError, true)
	assert.match(res.text, /id is required/)
})

test("kill_background stops a running command", { skip: process.platform === "win32" }, async () => {
	try {
		const start = await executeCommand({ command: "sleep 30", background: true }, context())
		const id = extractId(start.text)

		const killRes = await killBackground({ id }, context())
		assert.notEqual(killRes.isError, true)
		await waitForCompletion(id)

		const res = await checkBackground({ id }, context())
		assert.match(res.text, /Status: killed/)
	} finally {
		resetBackgroundCommands()
	}
})

test("kill_background on a finished command is a no-op, not an error", async () => {
	try {
		const start = await executeCommand({ command: "true", background: true }, context())
		const id = extractId(start.text)
		await waitForCompletion(id)

		const res = await killBackground({ id }, context())
		assert.notEqual(res.isError, true)
		assert.match(res.text, /not running/)
	} finally {
		resetBackgroundCommands()
	}
})

test("reset removes temp output files", async () => {
	const start = await executeCommand({ command: "echo cleanup-test", background: true }, context())
	const id = extractId(start.text)
	await waitForCompletion(id)

	const cmd = getBackgroundCommand(id)
	assert.ok(cmd)
	const outputFile = cmd.outputFile
	assert.ok(fs.existsSync(outputFile), "output file should exist before reset")

	resetBackgroundCommands()
	assert.equal(getBackgroundCommand(id), null)
	assert.ok(!fs.existsSync(outputFile), "output file should be deleted after reset")
	assert.ok(path.dirname(outputFile) === os.tmpdir())
})

test("foreground mode still works (regression)", async () => {
	const res = await executeCommand({ command: "echo fg-still-works" }, context())
	assert.equal(res.isError, false)
	assert.match(res.text, /fg-still-works/)
	assert.match(res.text, /Exit code: 0/)
})

test("subscribers are notified on start and finish", async () => {
	let calls = 0
	const unsubscribe = subscribeBackgroundCommands(() => calls++)
	try {
		const start = await executeCommand({ command: "echo notify", background: true }, context())
		assert.equal(calls, 1, "notified on start")
		await waitForCompletion(extractId(start.text))
		assert.equal(calls, 2, "notified on finish")
	} finally {
		unsubscribe()
		resetBackgroundCommands()
	}
})

test("finished commands are handed to the agent once", async () => {
	try {
		const start = await executeCommand({ command: "echo once", background: true }, context())
		const id = extractId(start.text)
		await waitForCompletion(id)
		const first = takeFinishedBackgroundCommands()
		assert.deepEqual(first.map((cmd) => cmd.id), [id])
		assert.deepEqual(takeFinishedBackgroundCommands(), [])
	} finally {
		resetBackgroundCommands()
	}
})

test("check_background on a finished command suppresses the completion notice", async () => {
	try {
		const start = await executeCommand({ command: "echo seen", background: true }, context())
		const id = extractId(start.text)
		await waitForCompletion(id)
		await checkBackground({ id }, context())
		assert.deepEqual(takeFinishedBackgroundCommands(), [])
	} finally {
		resetBackgroundCommands()
	}
})

test("output tail returns only the end of the log", async () => {
	try {
		const start = await executeCommand({ command: "echo aaaa; echo bbbb", background: true }, context())
		const id = extractId(start.text)
		await waitForCompletion(id)
		assert.equal(readBackgroundOutputTail(id, 5), "bbbb\n")
		assert.equal(readBackgroundOutputTail("bg_missing"), "")
	} finally {
		resetBackgroundCommands()
	}
})

test("a stringified null cwd runs in the workspace", async () => {
	try {
		const start = await executeCommand({ command: "pwd", cwd: "null", background: true }, context())
		const id = extractId(start.text)
		await waitForCompletion(id)
		const cmd = getBackgroundCommand(id)
		assert.equal(cmd?.status, "completed")
		assert.equal(fs.realpathSync(cmd!.output.trim()), fs.realpathSync(os.tmpdir()))
	} finally {
		resetBackgroundCommands()
	}
})

test("a missing cwd fails clearly instead of blaming the shell", async () => {
	const missing = path.join(os.tmpdir(), "orbcode-no-such-dir")
	for (const background of [true, false]) {
		const res = await executeCommand({ command: "echo hi", cwd: missing, background }, context())
		assert.equal(res.isError, true)
		assert.match(res.text, /working directory does not exist/)
	}
})

test("commands are scoped to the task that started them", async () => {
	try {
		const a = await executeCommand({ command: "echo a", background: true }, { ...context(), taskId: "task-a" })
		const b = await executeCommand({ command: "echo b", background: true }, { ...context(), taskId: "task-b" })
		const idA = extractId(a.text)
		const idB = extractId(b.text)
		assert.deepEqual(listBackgroundCommands("task-a").map((cmd) => cmd.id), [idA])
		await waitForCompletion(idA)
		await waitForCompletion(idB)
		// Task B's completion must not leak into task A's notices.
		assert.deepEqual(takeFinishedBackgroundCommands("task-a").map((cmd) => cmd.id), [idA])
		assert.deepEqual(takeFinishedBackgroundCommands("task-b").map((cmd) => cmd.id), [idB])
	} finally {
		resetBackgroundCommands()
	}
})

test("leaving a task stops only its running commands", { skip: process.platform === "win32" }, async () => {
	try {
		const a = await executeCommand({ command: "sleep 30", background: true }, { ...context(), taskId: "task-a" })
		const b = await executeCommand({ command: "sleep 30", background: true }, { ...context(), taskId: "task-b" })
		const idA = extractId(a.text)
		const idB = extractId(b.text)
		killBackgroundCommandsFor("task-a")
		await waitForCompletion(idA)
		assert.equal(getBackgroundCommand(idA)?.status, "killed")
		assert.equal(getBackgroundCommand(idB)?.status, "running")
	} finally {
		killBackgroundCommandsFor("task-b")
		resetBackgroundCommands()
	}
})
