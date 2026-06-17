// Test the project-hook trust gate. Run with: node test-hook-trust.mjs
import { loadSettings, getPendingProjectHooks, trustProjectHooks } from "./dist/config/settings.js"
import assert from "node:assert"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let passed = 0
const ok = (name) => { console.log(`  ok - ${name}`); passed++ }

const PROJECT_HOOKS = {
	hooks: {
		PreToolUse: [
			{ matcher: "execute_command", hooks: [{ type: "command", command: "echo from-project-hook" }] },
		],
	},
}

function fresh() {
	const cfg = mkdtempSync(join(tmpdir(), "orb-cfg-"))
	const proj = mkdtempSync(join(tmpdir(), "orb-proj-"))
	process.env.ORBCODE_CONFIG_DIR = cfg
	delete process.env.ORBCODE_TRUST_PROJECT_HOOKS
	process.chdir(proj)
	return { cfg, cwd: process.cwd() }
}

function writeProjectHooks(cwd, obj) {
	mkdirSync(join(cwd, ".orbcode"), { recursive: true })
	writeFileSync(join(cwd, ".orbcode", "settings.json"), JSON.stringify(obj))
}

// 1. Untrusted project hooks are NOT loaded, and are reported as pending.
{
	const { cwd } = fresh()
	writeProjectHooks(cwd, PROJECT_HOOKS)
	const s = loadSettings()
	assert.strictEqual(s.hooks, undefined, "untrusted project hooks must not be active")
	const pending = getPendingProjectHooks()
	assert.ok(pending, "pending project hooks reported")
	assert.deepEqual(pending.commands, ["echo from-project-hook"])
	ok("untrusted project hooks are disabled and reported as pending")
}

// 2. After trusting, project hooks load and nothing is pending.
{
	const { cwd } = fresh()
	writeProjectHooks(cwd, PROJECT_HOOKS)
	trustProjectHooks()
	const s = loadSettings()
	assert.ok(s.hooks?.PreToolUse, "trusted project hooks become active")
	assert.strictEqual(s.hooks.PreToolUse[0].hooks[0].command, "echo from-project-hook")
	assert.strictEqual(getPendingProjectHooks(), null, "nothing pending once trusted")
	ok("trusting enables project hooks")
}

// 3. Changing the hooks invalidates trust (re-prompt) and disables them again.
{
	const { cwd } = fresh()
	writeProjectHooks(cwd, PROJECT_HOOKS)
	trustProjectHooks()
	assert.strictEqual(getPendingProjectHooks(), null, "trusted before edit")
	// Edit the hooks: trust must no longer apply.
	writeProjectHooks(cwd, {
		hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo SOMETHING-NEW" }] }] },
	})
	const pending = getPendingProjectHooks()
	assert.ok(pending, "edited hooks are pending again")
	assert.deepEqual(pending.commands, ["echo SOMETHING-NEW"])
	assert.strictEqual(loadSettings().hooks, undefined, "edited hooks are disabled until re-trusted")
	ok("editing project hooks re-prompts (trust is content-hashed)")
}

// 4. ORBCODE_TRUST_PROJECT_HOOKS=1 trusts project hooks without prompting (CI).
{
	const { cwd } = fresh()
	writeProjectHooks(cwd, PROJECT_HOOKS)
	process.env.ORBCODE_TRUST_PROJECT_HOOKS = "1"
	assert.strictEqual(getPendingProjectHooks(), null, "env override => nothing pending")
	assert.ok(loadSettings().hooks?.PreToolUse, "env override => hooks active")
	delete process.env.ORBCODE_TRUST_PROJECT_HOOKS
	ok("ORBCODE_TRUST_PROJECT_HOOKS=1 enables project hooks (CI escape hatch)")
}

// 5. User-level hooks are ALWAYS active regardless of project trust.
{
	const { cfg, cwd } = fresh()
	writeFileSync(
		join(cfg, "settings.json"),
		JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] } }),
	)
	writeProjectHooks(cwd, PROJECT_HOOKS) // untrusted
	const s = loadSettings()
	assert.ok(s.hooks?.Stop, "user hooks active")
	assert.strictEqual(s.hooks.PreToolUse, undefined, "untrusted project hooks still excluded")
	ok("user hooks always apply; project hooks gated independently")
}

// 6. Trusted project hooks concatenate with user hooks (don't clobber).
{
	const { cfg, cwd } = fresh()
	writeFileSync(
		join(cfg, "settings.json"),
		JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo user" }] }] } }),
	)
	writeProjectHooks(cwd, PROJECT_HOOKS)
	trustProjectHooks()
	const s = loadSettings()
	const cmds = s.hooks.PreToolUse.flatMap((m) => m.hooks.map((h) => h.command))
	assert.deepEqual(cmds, ["echo user", "echo from-project-hook"], "user then project, merged")
	ok("trusted project hooks merge with (don't clobber) user hooks")
}

// 7. ORBCODE_TRUST_PROJECT_HOOKS only honors the exact value "1" (not "true").
{
	const { cwd } = fresh()
	writeProjectHooks(cwd, PROJECT_HOOKS)
	process.env.ORBCODE_TRUST_PROJECT_HOOKS = "true"
	const pending = getPendingProjectHooks()
	assert.ok(pending, '"true" must not be honored — only "1"')
	assert.strictEqual(loadSettings().hooks, undefined, '"true" must not enable hooks')
	delete process.env.ORBCODE_TRUST_PROJECT_HOOKS
	ok('ORBCODE_TRUST_PROJECT_HOOKS="true" is not honored (strict "1" only)')
}

console.log(`\n${passed} checks passed`)
