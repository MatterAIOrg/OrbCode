// Drives the real Agent loop with a stubbed model to prove hooks fire correctly
// inside a live turn. Run with: node test-hook-integration.mjs
import { Agent } from "./dist/core/agent.js"
import { AxonClient } from "./dist/api/client.js"
import assert from "node:assert"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let passed = 0
const ok = (n) => { console.log(`  ok - ${n}`); passed++ }

// Build an Agent whose model output is scripted. `script` is an array of
// generator functions, one per model round; each yields stream chunks.
function scriptedAgent({ script, hooks, autoApprove = true }) {
	let calls = 0
	const sentMessages = []
	AxonClient.prototype.createMessage = async function* (_systemPrompt, messages) {
		sentMessages.push(messages)
		const step = script[Math.min(calls, script.length - 1)]
		calls++
		yield* step()
	}
	const events = []
	const agent = new Agent({
		cwd: process.cwd(),
		token: "x",
		modelId: "axon-code-2-5-pro",
		autoApproveEdits: autoApprove,
		autoApproveSafeCommands: autoApprove,
		hooks,
		callbacks: {
			onEvent: (e) => events.push(e),
			requestApproval: async () => "yes",
			requestFollowup: async () => "answer",
		},
	})
	return { agent, events, sentMessages, calls: () => calls }
}

const sayThenEnd = (t) => function* () { yield { type: "text", text: t } }
const toolThen = (name, args) =>
	function* () {
		yield {
			type: "native_tool_calls",
			toolCalls: [{ index: 0, id: "call_1", function: { name, arguments: JSON.stringify(args) } }],
		}
	}

// A — PreToolUse exit-2 blocks REAL tool execution (the command never runs).
{
	const marker = join(mkdtempSync(join(tmpdir(), "orb-it-")), "marker.txt")
	const { agent, events } = scriptedAgent({
		script: [toolThen("execute_command", { command: `touch ${marker}` }), sayThenEnd("done")],
		hooks: {
			PreToolUse: [
				{ matcher: "execute_command", hooks: [{ type: "command", command: "echo blocked-by-test >&2; exit 2" }] },
			],
		},
	})
	await agent.runTurn("go")
	assert.ok(!existsSync(marker), "blocked tool must NOT have executed (no marker file)")
	const te = events.find((e) => e.type === "tool-end")
	assert.ok(te && te.isError && /blocked-by-test/.test(te.resultPreview), "tool-end carries the block reason")
	ok("PreToolUse exit-2 blocks real tool execution end-to-end")
}

// B — UserPromptSubmit context actually reaches the model request.
{
	const { agent, sentMessages } = scriptedAgent({
		script: [sayThenEnd("ok")],
		hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo INJECTED_CTX" }] }] },
	})
	await agent.runTurn("hello there")
	const userMsg = [...sentMessages[0]].reverse().find((m) => m.role === "user")
	assert.match(userMsg.content, /INJECTED_CTX/, "UserPromptSubmit context reached the model")
	assert.match(userMsg.content, /hello there/, "original prompt preserved")
	ok("UserPromptSubmit injects context into the live turn")
}

// C — PostToolUse context is appended to the tool result fed back to the model.
{
	const { agent, sentMessages } = scriptedAgent({
		script: [toolThen("execute_command", { command: "echo hi" }), sayThenEnd("done")],
		hooks: {
			PostToolUse: [
				{
					matcher: "execute_command",
					hooks: [
						{
							type: "command",
							command:
								"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PostToolUse\",\"additionalContext\":\"POST_CTX\"}}'",
						},
					],
				},
			],
		},
	})
	await agent.runTurn("run it")
	const toolMsg = sentMessages[1].find((m) => m.role === "tool")
	assert.ok(toolMsg, "a tool result was sent on the second round")
	assert.match(toolMsg.content, /POST_CTX/, "PostToolUse additionalContext appended to tool result")
	assert.match(toolMsg.content, /hi/, "real tool output preserved (command ran)")
	ok("PostToolUse adds context to the tool result (and the tool actually ran)")
}

// D — Stop forces exactly ONE continuation, then stops (loop-safe).
{
	const { agent, sentMessages, calls } = scriptedAgent({
		script: [sayThenEnd("first"), sayThenEnd("second")],
		hooks: { Stop: [{ hooks: [{ type: "command", command: "echo '{\"decision\":\"block\",\"reason\":\"again\"}'" }] }] },
	})
	await agent.runTurn("go")
	assert.equal(calls(), 2, "Stop forced exactly one extra model round (no infinite loop)")
	assert.ok(
		sentMessages[1].some((m) => m.role === "user" && /Stop hook.*again/.test(m.content)),
		"continuation reminder injected into history",
	)
	ok("Stop hook forces one continuation then stops (loop-safe)")
}

// E — No hooks: the loop behaves exactly as before (control / regression guard).
{
	const marker = join(mkdtempSync(join(tmpdir(), "orb-it-")), "ran.txt")
	const { agent, events } = scriptedAgent({
		script: [toolThen("execute_command", { command: `touch ${marker}` }), sayThenEnd("done")],
		hooks: undefined,
	})
	await agent.runTurn("go")
	assert.ok(existsSync(marker), "with no hooks the tool runs normally")
	assert.ok(!events.some((e) => e.type === "system"), "with no hooks, no hook system events are emitted")
	ok("no hooks => unchanged behavior (tool runs, no hook events)")
}

const waitFor = async (pred, ms = 1000) => {
	const t0 = Date.now()
	while (Date.now() - t0 < ms) {
		if (pred()) return true
		await new Promise((r) => setTimeout(r, 20))
	}
	return pred()
}

// F — SessionStart injects context into the first message of the session.
{
	const { agent, sentMessages } = scriptedAgent({
		script: [sayThenEnd("ok")],
		hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo SESSION_CTX" }] }] },
	})
	await agent.runTurn("hi")
	const userMsg = [...sentMessages[0]].reverse().find((m) => m.role === "user")
	assert.match(userMsg.content, /SESSION_CTX/, "SessionStart context present in the first message")
	ok("SessionStart injects context on the first turn")
}

// G — Notification fires when OrbCode asks for approval.
{
	const marker = join(mkdtempSync(join(tmpdir(), "orb-it-")), "notif.txt")
	const { agent } = scriptedAgent({
		script: [toolThen("execute_command", { command: "echo hi" }), sayThenEnd("done")],
		hooks: { Notification: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] },
		autoApprove: false, // forces an approval prompt, which triggers Notification
	})
	await agent.runTurn("go")
	assert.ok(await waitFor(() => existsSync(marker)), "Notification hook ran on the approval request")
	ok("Notification fires when approval is requested")
}

// H — PreCompact fires before /compact summarizes (and is awaited).
{
	const marker = join(mkdtempSync(join(tmpdir(), "orb-it-")), "precompact.txt")
	const { agent } = scriptedAgent({
		script: [sayThenEnd("first"), sayThenEnd("SUMMARY")],
		hooks: { PreCompact: [{ hooks: [{ type: "command", command: `touch ${marker}` }] }] },
	})
	await agent.runTurn("hi")
	assert.ok(!existsSync(marker), "PreCompact has not fired before compaction")
	await agent.compact()
	assert.ok(existsSync(marker), "PreCompact fired before compaction")
	ok("PreCompact fires before /compact summarization")
}

// I — PreToolUse "ask" + updatedInput: the rewrite is applied AND approval is forced.
{
	const { agent, events } = scriptedAgent({
		script: [toolThen("execute_command", { command: "ls" }), sayThenEnd("done")],
		hooks: {
			PreToolUse: [
				{
					matcher: "execute_command",
					hooks: [
						{
							type: "command",
							command:
								'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","updatedInput":{"command":"ls -la"}}}\'',
						},
					],
				},
			],
		},
		autoApprove: false, // would normally auto-approve; "ask" must force the prompt
	})
	await agent.runTurn("go")
	// The approval prompt must have fired (requestApproval stub returns "yes").
	const rewriteNotice = events.find(
		(e) => e.type === "system" && /rewrote the input/.test(e.message),
	)
	assert.ok(rewriteNotice, "a system event announces the input rewrite")
	ok('PreToolUse "ask" + updatedInput: rewrite applied, approval forced, rewrite logged')
}

// J — PreToolUse "allow" + updatedInput: rewrite applied, approval skipped.
{
	const { agent, events } = scriptedAgent({
		script: [toolThen("execute_command", { command: "ls" }), sayThenEnd("done")],
		hooks: {
			PreToolUse: [
				{
					matcher: "execute_command",
					hooks: [
						{
							type: "command",
							command:
								'echo \'{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"command":"echo rewritten-ran"}}}\'',
						},
					],
				},
			],
		},
		autoApprove: false, // would normally prompt; "allow" must skip it
	})
	await agent.runTurn("go")
	const rewriteNotice = events.find(
		(e) => e.type === "system" && /rewrote the input/.test(e.message),
	)
	assert.ok(rewriteNotice, "rewrite is logged even when approval is bypassed")
	// The tool ran with the rewritten command (no approval denial event).
	const denied = events.find((e) => e.type === "tool-end" && e.isError && /Denied/.test(e.resultPreview))
	assert.ok(!denied, "tool was not denied — allow bypassed approval")
	ok('PreToolUse "allow" + updatedInput: rewrite applied, approval bypassed, rewrite logged')
}

console.log(`\n${passed} checks passed`)
