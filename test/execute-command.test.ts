import assert from "node:assert/strict"
import { execSync } from "node:child_process"
import test from "node:test"
import * as os from "node:os"

import { executeCommand } from "../src/tools/executors/executeCommand.js"

const context = (signal?: AbortSignal) => ({ cwd: os.tmpdir(), token: "", getTodos: () => "", setTodos: () => {}, signal })

test("normal command returns output and exit code", async () => {
	const res = await executeCommand({ command: "echo hello" }, context())
	assert.equal(res.isError, false)
	assert.match(res.text, /hello/)
	assert.match(res.text, /Exit code: 0/)
})

test("interrupt kills the whole process tree, including grandchildren holding the pipe", { skip: process.platform === "win32" }, async () => {
	const marker = `orbcode-grandchild-${process.pid}-${Date.now()}`
	const controller = new AbortController()
	const started = Date.now()
	// The shell forks `sleep`; the pipeline keeps stdout open through the grandchild.
	const pending = executeCommand({ command: `(exec -a ${marker} sleep 30; echo late) | cat` }, context(controller.signal))
	setTimeout(() => controller.abort(), 300)
	const res = await pending
	assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`)
	assert.equal(res.isError, true)
	assert.match(res.text, /user interrupted/)
	const survivors = execSync(`pgrep -f ${marker} || true`).toString().trim()
	assert.equal(survivors, "", "grandchild process survived the interrupt")
})

test("an already-aborted turn does not start the command", async () => {
	const controller = new AbortController()
	controller.abort()
	const res = await executeCommand({ command: "echo should-not-run" }, context(controller.signal))
	assert.equal(res.isError, true)
	assert.doesNotMatch(res.text, /should-not-run/)
})
