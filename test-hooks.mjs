// Ad-hoc functional test for the hooks engine. Run with: node test-hooks.mjs
import { HookRunner } from "./dist/core/hooks.js"
import assert from "node:assert"

let passed = 0
const ok = (name) => { console.log(`  ok - ${name}`); passed++ }

function makeRunner(config) {
	const systemMessages = []
	const runner = new HookRunner({
		cwd: process.cwd(),
		sessionId: "test-session",
		transcriptPath: "/tmp/test-session.json",
		config,
		onSystemMessage: (message, isError) => systemMessages.push({ message, isError }),
	})
	return { runner, systemMessages }
}

// 1. No config -> no-op
{
	const { runner } = makeRunner(undefined)
	assert.equal(runner.hasHooks("PreToolUse"), false)
	const r = await runner.run("PreToolUse", { tool_name: "execute_command", tool_input: {} })
	assert.equal(r.blocked, false)
	assert.equal(r.stopAll, false)
	ok("no config is a no-op")
}

// 2. PreToolUse deny via exit code 2, with matcher on tool name
{
	const { runner } = makeRunner({
		PreToolUse: [
			{
				matcher: "execute_command",
				hooks: [{ type: "command", command: "echo 'nope, blocked' >&2; exit 2" }],
			},
		],
	})
	const blocked = await runner.run("PreToolUse", { tool_name: "execute_command", tool_input: { command: "rm -rf /" } })
	assert.equal(blocked.blocked, true)
	assert.match(blocked.blockReason, /nope, blocked/)
	// Different tool name shouldn't match the matcher.
	const allowed = await runner.run("PreToolUse", { tool_name: "read_file", tool_input: {} })
	assert.equal(allowed.blocked, false)
	ok("PreToolUse exit-2 blocks, matcher scopes to tool name")
}

// 3. PreToolUse JSON permissionDecision: allow (bypass approval)
{
	const { runner } = makeRunner({
		PreToolUse: [
			{
				hooks: [
					{
						type: "command",
						command:
							"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'",
					},
				],
			},
		],
	})
	const r = await runner.run("PreToolUse", { tool_name: "execute_command", tool_input: {} })
	assert.equal(r.permissionDecision, "allow")
	assert.equal(r.blocked, false)
	ok("PreToolUse JSON permissionDecision allow")
}

// 4. PreToolUse updatedInput rewrites tool args
{
	const { runner } = makeRunner({
		PreToolUse: [
			{
				hooks: [
					{
						type: "command",
						command:
							"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"ls -la\"}}}'",
					},
				],
			},
		],
	})
	const r = await runner.run("PreToolUse", { tool_name: "execute_command", tool_input: { command: "ls" } })
	assert.deepEqual(r.updatedInput, { command: "ls -la" })
	ok("PreToolUse updatedInput")
}

// 5. UserPromptSubmit: plain stdout becomes additionalContext
{
	const { runner } = makeRunner({
		UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo 'remember: be concise'" }] }],
	})
	const r = await runner.run("UserPromptSubmit", { prompt: "hello" })
	assert.equal(r.additionalContext.trim(), "remember: be concise")
	assert.equal(r.blocked, false)
	ok("UserPromptSubmit plain stdout -> additionalContext")
}

// 6. UserPromptSubmit: decision block
{
	const { runner } = makeRunner({
		UserPromptSubmit: [
			{ hooks: [{ type: "command", command: "echo '{\"decision\":\"block\",\"reason\":\"secrets!\"}'" }] },
		],
	})
	const r = await runner.run("UserPromptSubmit", { prompt: "print my AWS key" })
	assert.equal(r.blocked, true)
	assert.equal(r.blockReason, "secrets!")
	ok("UserPromptSubmit JSON decision block")
}

// 7. continue:false sets stopAll
{
	const { runner } = makeRunner({
		Stop: [{ hooks: [{ type: "command", command: "echo '{\"continue\":false,\"stopReason\":\"all done\"}'" }] }],
	})
	const r = await runner.run("Stop", { stop_hook_active: false })
	assert.equal(r.stopAll, true)
	assert.equal(r.stopReason, "all done")
	ok("continue:false -> stopAll")
}

// 8. Stop decision block (forces continuation upstream)
{
	const { runner } = makeRunner({
		Stop: [{ hooks: [{ type: "command", command: "echo '{\"decision\":\"block\",\"reason\":\"keep going\"}'" }] }],
	})
	const r = await runner.run("Stop", { stop_hook_active: false })
	assert.equal(r.blocked, true)
	assert.equal(r.blockReason, "keep going")
	ok("Stop decision block")
}

// 9. systemMessage is surfaced; non-blocking error (exit 1) surfaces stderr
{
	const { runner, systemMessages } = makeRunner({
		PostToolUse: [
			{ hooks: [{ type: "command", command: "echo '{\"systemMessage\":\"FYI from hook\"}'" }] },
			{ hooks: [{ type: "command", command: "echo 'boom' >&2; exit 1" }] },
		],
	})
	await runner.run("PostToolUse", { tool_name: "file_write", tool_input: {}, tool_response: "ok" })
	assert.ok(systemMessages.some((m) => m.message === "FYI from hook" && !m.isError))
	assert.ok(systemMessages.some((m) => /boom/.test(m.message) && m.isError))
	ok("systemMessage + non-blocking stderr surfaced")
}

// 10. The hook receives the JSON payload on stdin (round-trip the event name)
{
	const { runner } = makeRunner({
		UserPromptSubmit: [
			{
				hooks: [
					{
						// Read stdin and echo it back behind a prefix so the output
						// is treated as plain text (not a JSON control object).
						type: "command",
						command: "printf 'GOT:'; cat",
					},
				],
			},
		],
	})
	const r = await runner.run("UserPromptSubmit", { prompt: "hi" })
	const payload = JSON.parse(r.additionalContext.slice("GOT:".length))
	assert.equal(payload.hook_event_name, "UserPromptSubmit")
	assert.equal(payload.session_id, "test-session")
	assert.equal(payload.prompt, "hi")
	assert.equal(payload.transcript_path, "/tmp/test-session.json")
	ok("hook receives full JSON payload on stdin")
}

// 11. MATTERAI_PROJECT_DIR is exported to the hook
{
	const { runner } = makeRunner({
		SessionStart: [{ hooks: [{ type: "command", command: 'printf "%s" "$MATTERAI_PROJECT_DIR"' }] }],
	})
	const r = await runner.run("SessionStart", { source: "startup" })
	assert.equal(r.additionalContext, process.cwd())
	ok("MATTERAI_PROJECT_DIR exported to hook")
}

// 12. timeout: a slow hook is killed and surfaces a timeout message
{
	const { runner, systemMessages } = makeRunner({
		Notification: [{ hooks: [{ type: "command", command: "sleep 5", timeout: 1 }] }],
	})
	const start = Date.now()
	await runner.run("Notification", { message: "x" })
	const elapsed = Date.now() - start
	assert.ok(elapsed < 4000, `expected timeout < 4s, took ${elapsed}ms`)
	assert.ok(systemMessages.some((m) => /timed out/.test(m.message)))
	ok("slow hook is killed by timeout")
}

// 13. Aggregation: across matching hooks, the most restrictive decision wins.
{
	const allow =
		"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'"
	const deny =
		"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"nope\"}}'"
	const { runner } = makeRunner({
		PreToolUse: [{ hooks: [{ type: "command", command: allow }, { type: "command", command: deny }] }],
	})
	const r = await runner.run("PreToolUse", { tool_name: "execute_command", tool_input: {} })
	assert.equal(r.permissionDecision, "deny")
	assert.equal(r.blocked, true)
	assert.match(r.blockReason, /nope/)
	ok("aggregation: deny beats allow")
}

// 14. Matcher "*" and an omitted matcher both match every tool.
{
	const { runner, systemMessages } = makeRunner({
		PreToolUse: [
			{ matcher: "*", hooks: [{ type: "command", command: "echo '{\"systemMessage\":\"star\"}'" }] },
			{ hooks: [{ type: "command", command: "echo '{\"systemMessage\":\"omitted\"}'" }] },
		],
	})
	await runner.run("PreToolUse", { tool_name: "anything", tool_input: {} })
	assert.ok(systemMessages.some((m) => m.message === "star"))
	assert.ok(systemMessages.some((m) => m.message === "omitted"))
	ok('matcher "*" and omitted both match')
}

// 15. A non-blocking error (exit 1, not 2) does not block.
{
	const { runner } = makeRunner({
		PostToolUse: [{ hooks: [{ type: "command", command: "echo oops >&2; exit 1" }] }],
	})
	const r = await runner.run("PostToolUse", { tool_name: "file_write", tool_input: {}, tool_response: "ok" })
	assert.equal(r.blocked, false)
	ok("exit 1 is non-blocking")
}

// 16. updatedInput: last matching hook wins.
{
	const first =
		"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"first\"}}}'"
	const second =
		"echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"updatedInput\":{\"command\":\"second\"}}}'"
	const { runner } = makeRunner({
		PreToolUse: [{ hooks: [{ type: "command", command: first }, { type: "command", command: second }] }],
	})
	const r = await runner.run("PreToolUse", { tool_name: "execute_command", tool_input: { command: "orig" } })
	assert.deepEqual(r.updatedInput, { command: "second" })
	ok("updatedInput: last wins")
}

// 17. SubagentStop is a supported event (runs without error).
{
	const { runner, systemMessages } = makeRunner({
		SubagentStop: [{ hooks: [{ type: "command", command: "echo '{\"systemMessage\":\"sub\"}'" }] }],
	})
	assert.equal(runner.hasHooks("SubagentStop"), true)
	const r = await runner.run("SubagentStop", { stop_hook_active: false })
	assert.equal(r.blocked, false)
	assert.ok(systemMessages.some((m) => m.message === "sub"))
	ok("SubagentStop event is supported")
}

// 18. Matcher is auto-anchored: "execute_command" does NOT match "execute_command_extra".
{
	const { runner } = makeRunner({
		PreToolUse: [
			{ matcher: "execute_command", hooks: [{ type: "command", command: "echo '{\"systemMessage\":\"matched\"}'" }] },
		],
	})
	const r = await runner.run("PreToolUse", { tool_name: "execute_command_extra", tool_input: {} })
	assert.equal(r.blocked, false, "auto-anchored matcher must not match substrings")
	ok("matcher auto-anchoring: no substring match")
}

// 19. Matcher alternation still works with auto-anchoring.
{
	const { runner, systemMessages } = makeRunner({
		PreToolUse: [
			{ matcher: "read_file|list_files", hooks: [{ type: "command", command: "echo '{\"systemMessage\":\"alt\"}'" }] },
		],
	})
	await runner.run("PreToolUse", { tool_name: "read_file", tool_input: {} })
	await runner.run("PreToolUse", { tool_name: "list_files", tool_input: {} })
	const r = await runner.run("PreToolUse", { tool_name: "execute_command", tool_input: {} })
	assert.ok(systemMessages.filter((m) => m.message === "alt").length === 2, "both alternation targets matched")
	assert.equal(r.blocked, false, "non-matching tool not hit")
	ok("matcher alternation works with auto-anchoring")
}

// 20. A hook that ignores SIGTERM is force-killed via SIGKILL escalation.
{
	const { runner, systemMessages } = makeRunner({
		Notification: [
			{
				hooks: [
					{
						type: "command",
						// Trap SIGTERM and keep running; only SIGKILL will stop us.
						command: "trap '' TERM; sleep 30",
						timeout: 1,
					},
				],
			},
		],
	})
	const start = Date.now()
	await runner.run("Notification", { message: "x" })
	const elapsed = Date.now() - start
	assert.ok(elapsed < 5000, `expected SIGKILL escalation < 5s, took ${elapsed}ms`)
	assert.ok(systemMessages.some((m) => /timed out/.test(m.message)))
	ok("SIGTERM-ignoring hook is force-killed by SIGKILL escalation")
}

// 21. Injected additionalContext is capped (no context-window blowup).
{
	const big = "X".repeat(50_000)
	const { runner } = makeRunner({
		UserPromptSubmit: [{ hooks: [{ type: "command", command: `printf '%s' '${big}'` }] }],
	})
	const r = await runner.run("UserPromptSubmit", { prompt: "hi" })
	assert.ok(r.additionalContext.length <= 8200, `context cap not enforced (got ${r.additionalContext.length} chars)`)
	assert.ok(/truncated/.test(r.additionalContext), "cap marker present")
	ok("additionalContext is capped to prevent context-window blowup")
}

console.log(`\n${passed} checks passed`)
