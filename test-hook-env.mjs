// Test that hooks never see OrbCode credentials (or other secret-like env vars).
// Run with: node test-hook-env.mjs
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

// Set up credential-like env vars that must NEVER reach a hook.
process.env.ORBCODE_TOKEN = "secret-orbcode-token"
process.env.ORBCODE_API_KEY = "secret-api-key"
process.env.ORBCODE_CONFIG_DIR = "/should/not/leak"
process.env.MY_GITHUB_TOKEN = "ghp_secret"
process.env.AWS_SECRET_ACCESS_KEY = "aws-secret"
process.env.DATABASE_PASSWORD = "db-pass"

// 1. ORBCODE_TOKEN and ORBCODE_API_KEY are redacted from the hook env.
{
	const { runner } = makeRunner({
		SessionStart: [{ hooks: [{ type: "command", command: "env" }] }],
	})
	const r = await runner.run("SessionStart", { source: "startup" })
	const envOutput = r.additionalContext || ""
	assert.ok(!envOutput.includes("secret-orbcode-token"), "ORBCODE_TOKEN must not leak to hooks")
	assert.ok(!envOutput.includes("secret-api-key"), "ORBCODE_API_KEY must not leak to hooks")
	assert.ok(!envOutput.includes("/should/not/leak"), "ORBCODE_CONFIG_DIR must not leak to hooks")
	ok("OrbCode credential env vars are redacted from hooks")
}

// 2. Credential-like patterns (TOKEN, SECRET, PASSWORD) are redacted too.
{
	const { runner } = makeRunner({
		SessionStart: [{ hooks: [{ type: "command", command: "env" }] }],
	})
	const r = await runner.run("SessionStart", { source: "startup" })
	const envOutput = r.additionalContext || ""
	assert.ok(!envOutput.includes("ghp_secret"), "MY_GITHUB_TOKEN must not leak")
	assert.ok(!envOutput.includes("aws-secret"), "AWS_SECRET_ACCESS_KEY must not leak")
	assert.ok(!envOutput.includes("db-pass"), "DATABASE_PASSWORD must not leak")
	ok("credential-pattern env vars (TOKEN/SECRET/PASSWORD) are redacted")
}

// 3. Non-credential env vars (PATH, HOME, ORBCODE_PROJECT_DIR) are preserved.
{
	const { runner } = makeRunner({
		SessionStart: [{ hooks: [{ type: "command", command: "env" }] }],
	})
	const r = await runner.run("SessionStart", { source: "startup" })
	const envOutput = r.additionalContext || ""
	assert.ok(envOutput.includes("ORBCODE_PROJECT_DIR"), "ORBCODE_PROJECT_DIR must be present")
	assert.ok(envOutput.includes("PATH="), "PATH must be preserved")
	ok("non-credential env vars (PATH, ORBCODE_PROJECT_DIR) are preserved")
}

// Cleanup
delete process.env.ORBCODE_TOKEN
delete process.env.ORBCODE_API_KEY
delete process.env.ORBCODE_CONFIG_DIR
delete process.env.MY_GITHUB_TOKEN
delete process.env.AWS_SECRET_ACCESS_KEY
delete process.env.DATABASE_PASSWORD

console.log(`\n${passed} checks passed`)
