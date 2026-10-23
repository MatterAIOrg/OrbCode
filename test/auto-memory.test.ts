import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-automem-"))
process.env.MATTERAI_CONFIG_DIR = configDir
const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-claude-"))
process.env.CLAUDE_CONFIG_DIR = claudeDir
delete process.env.ORBCODE_DISABLE_AUTO_MEMORY
delete process.env.ORBCODE_AUTO_MEMORY_DIR

const {
	MAX_INDEX_LINES,
	isInMemoryDir,
	listMemoryFiles,
	readMemoryIndex,
	renderAutoMemorySection,
	resolveAutoMemory,
	sanitizeProjectKey,
} = await import("../src/memory/autoMemory.js")
const { saveAutoMemoryEnabled } = await import("../src/config/settings.js")
const { buildContextReminders } = await import("../src/prompts/system.js")
const { loadMemoryFiles, renderMemorySection } = await import("../src/memory/loader.js")

function tempProject(): string {
	return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-proj-")))
}

test("project key replaces every non-alphanumeric character, like Claude Code", () => {
	assert.equal(sanitizeProjectKey("/Users/me/my_app.v2"), "-Users-me-my-app-v2")
	const long = sanitizeProjectKey("/" + "a".repeat(300))
	assert.ok(long.length < 220)
	assert.match(long, /-[0-9a-f]{8}$/)
})

test("memory dir lives under the config dir, keyed by the git root", () => {
	const project = tempProject()
	execFileSync("git", ["init", "-q"], { cwd: project })
	const nested = path.join(project, "src", "deep")
	fs.mkdirSync(nested, { recursive: true })
	const memory = resolveAutoMemory(nested)
	assert.equal(memory.enabled, true)
	assert.equal(memory.dir, path.join(configDir, "projects", sanitizeProjectKey(project), "memory"))
})

test("MEMORY.md is loaded into the reminder and truncated past the line cap", () => {
	const project = tempProject()
	const memory = resolveAutoMemory(project)
	const empty = renderAutoMemorySection(memory)
	assert.ok(fs.existsSync(memory.dir), "memory dir is created up front")
	assert.match(empty, /persistent file-based memory/)
	assert.match(empty, /MEMORY\.md is currently empty/)

	fs.writeFileSync(path.join(memory.dir, "MEMORY.md"), "- [Terse](terse.md) — keep replies short\n")
	fs.writeFileSync(path.join(memory.dir, "terse.md"), "---\nname: terse\n---\nbody")
	const section = renderAutoMemorySection(memory)
	assert.match(section, /user's auto-memory, persists across conversations/)
	assert.match(section, /keep replies short/)
	assert.deepEqual(listMemoryFiles(memory.dir), [path.join(memory.dir, "terse.md")])

	const lines = Array.from({ length: MAX_INDEX_LINES + 50 }, (_, i) => `- line ${i}`)
	fs.writeFileSync(path.join(memory.dir, "MEMORY.md"), lines.join("\n"))
	const index = readMemoryIndex(memory.dir)
	assert.equal(index.truncated, true)
	assert.equal(index.content.split("\n").length, MAX_INDEX_LINES)
	assert.match(renderAutoMemorySection(memory), /WARNING: MEMORY\.md exceeds/)
})

test("auto memory can be turned off via settings or env", () => {
	const project = tempProject()
	saveAutoMemoryEnabled(false)
	assert.equal(resolveAutoMemory(project).enabled, false)
	assert.equal(renderAutoMemorySection(resolveAutoMemory(project)), "")
	saveAutoMemoryEnabled(true)
	assert.equal(resolveAutoMemory(project).enabled, true)
	process.env.ORBCODE_DISABLE_AUTO_MEMORY = "1"
	assert.equal(resolveAutoMemory(project).enabled, false)
	delete process.env.ORBCODE_DISABLE_AUTO_MEMORY
})

test("autoMemoryDirectory is honored from user settings but not project settings", () => {
	const project = tempProject()
	fs.mkdirSync(path.join(project, ".orbcode"))
	fs.writeFileSync(path.join(project, ".orbcode", "settings.json"), JSON.stringify({ autoMemoryDirectory: "/tmp/evil" }))
	assert.notEqual(resolveAutoMemory(project).dir, "/tmp/evil")

	const userSettings = path.join(configDir, "settings.json")
	const custom = path.join(configDir, "custom-memory")
	fs.writeFileSync(userSettings, JSON.stringify({ autoMemoryDirectory: custom }))
	assert.equal(resolveAutoMemory(project).dir, custom)
	fs.writeFileSync(userSettings, "{}")
})

test("isInMemoryDir only matches paths inside the directory", () => {
	const dir = "/home/u/.orbcode/projects/x/memory"
	assert.equal(isInMemoryDir(`${dir}/a.md`, dir), true)
	assert.equal(isInMemoryDir(`${dir}/MEMORY.md`, dir), true)
	assert.equal(isInMemoryDir(`${dir}/../../escape.md`, dir), false)
	assert.equal(isInMemoryDir(`${dir}-other/a.md`, dir), false)
})

test("the auto-memory reminder rides along with the first-message reminders", () => {
	const reminders = buildContextReminders("", "", "# Memory\nstuff")
	assert.equal(reminders, "<system-reminder>\n# Memory\nstuff\n</system-reminder>")
})

test("agent loads memory into the first message and writes it without an approval prompt", async () => {
	const { Agent } = await import("../src/core/agent.js")
	const project = tempProject()
	const memory = resolveAutoMemory(project)
	fs.mkdirSync(memory.dir, { recursive: true })
	fs.writeFileSync(path.join(memory.dir, "MEMORY.md"), "- [Tabs](tabs.md) — user prefers tabs\n")

	const memoryFile = path.join(memory.dir, "role.md")
	const projectFile = path.join(project, "notes.md")
	const steps = [
		[{ name: "file_write", args: { file_path: memoryFile, content: "memory", line_count: 1 } }],
		[{ name: "file_write", args: { file_path: projectFile, content: "project", line_count: 1 } }],
	]
	let firstMessage = ""
	let step = 0
	const client = {
		async *createMessage(_system: string, messages: { role: string; content: unknown }[], tools: unknown[]) {
			if (!firstMessage) firstMessage = String(messages.find((m) => m.role === "user")?.content)
			const calls = tools.length > 0 ? steps[step++] : undefined
			if (calls) {
				yield {
					type: "native_tool_calls" as const,
					toolCalls: calls.map((call, i) => ({
						index: i,
						id: `call_${step}_${i}`,
						type: "function" as const,
						function: { name: call.name, arguments: JSON.stringify(call.args) },
					})),
				}
			} else {
				yield { type: "text" as const, text: "done" }
			}
			yield { type: "usage" as const, inputTokens: 1000, outputTokens: 10, totalCost: 0 }
		},
	}
	const approvals: string[] = []
	const agent = new Agent({
		cwd: project,
		token: "",
		modelId: "zai/glm-5.3-flash",
		autoApproveEdits: false,
		autoApproveSafeCommands: false,
		client: client as never,
		callbacks: {
			onEvent: () => {},
			requestApproval: async (request: { detail?: string }) => {
				approvals.push(String(request.detail ?? ""))
				return "yes"
			},
			requestFollowup: async () => "ok",
		} as never,
	})
	await agent.runTurn("remember my role, then write notes")

	assert.match(firstMessage, /user prefers tabs/)
	assert.match(firstMessage, new RegExp(memory.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
	assert.equal(fs.readFileSync(memoryFile, "utf8"), "memory")
	assert.equal(fs.readFileSync(projectFile, "utf8"), "project")
	assert.equal(approvals.length, 1, "only the write outside the memory dir asks for approval")
	assert.match(approvals[0], /notes\.md/)
})

test("CLAUDE.md files load alongside AGENTS.md, and a shared file loads once", () => {
	const project = tempProject()
	fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), "user claude rules")
	fs.writeFileSync(path.join(project, "AGENTS.md"), "agents rules")
	fs.writeFileSync(path.join(project, "CLAUDE.md"), "@AGENTS.md\nclaude rules")
	fs.mkdirSync(path.join(project, ".claude"))
	fs.writeFileSync(path.join(project, ".claude", "CLAUDE.md"), "dot-claude rules")
	fs.writeFileSync(path.join(project, "CLAUDE.local.md"), "local claude rules")

	const files = loadMemoryFiles(project)
	const byPath = (p: string) => files.filter((f) => f.path === p)
	assert.equal(byPath(path.join(project, "AGENTS.md")).length, 1, "AGENTS.md included from CLAUDE.md isn't duplicated")
	assert.deepEqual(
		files.map((f) => [path.relative(project, f.path) || f.path, f.type]).filter(([p]) => !String(p).startsWith("..")),
		[
			["AGENTS.md", "project"],
			["CLAUDE.md", "project"],
			[path.join(".claude", "CLAUDE.md"), "project"],
			["CLAUDE.local.md", "local"],
		],
	)
	assert.equal(files[0].path, path.join(claudeDir, "CLAUDE.md"))
	assert.equal(files[0].type, "user")
	assert.match(renderMemorySection(files), /AGENTS\.md \/ CLAUDE\.md/)
	fs.rmSync(path.join(claudeDir, "CLAUDE.md"))
})

test("Claude Code's memories for the project are loaded read-only", () => {
	const project = tempProject()
	const claudeMemory = path.join(claudeDir, "projects", sanitizeProjectKey(project), "memory")
	fs.mkdirSync(claudeMemory, { recursive: true })
	fs.writeFileSync(path.join(claudeMemory, "MEMORY.md"), "- [No attribution](no-attr.md) — never add co-author lines\n")

	const memory = resolveAutoMemory(project)
	assert.equal(memory.claudeDir, claudeMemory)
	const section = renderAutoMemorySection(memory)
	assert.match(section, /Claude Code memories \(read-only\)/)
	assert.match(section, /never add co-author lines/)
	assert.match(section, /Don't edit or delete files in that directory/)

	// Pointing OrbCode's own memory at Claude's folder shares it instead of loading it twice.
	process.env.ORBCODE_AUTO_MEMORY_DIR = claudeMemory
	assert.equal(resolveAutoMemory(project).claudeDir, undefined)
	delete process.env.ORBCODE_AUTO_MEMORY_DIR

	// Without any saved Claude memories there's nothing to load.
	assert.equal(resolveAutoMemory(tempProject()).claudeDir, undefined)
})
