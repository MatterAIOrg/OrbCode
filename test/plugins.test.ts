import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"

import { loadMcpConfig } from "../src/mcp/config.js"
import { installMarketplacePlugin, listInstalledPlugins } from "../src/plugins/manager.js"
import type { MarketplacePlugin } from "../src/plugins/types.js"
import { loadSkills, renderSkillContent } from "../src/skills/loader.js"

function write(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, content)
}

test("installs and loads a complete marketplace plugin bundle", async () => {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-plugin-test-"))
	const repo = path.join(temp, "source")
	const project = path.join(temp, "project")
	fs.mkdirSync(repo)
	fs.mkdirSync(project)

	try {
		write(
			path.join(repo, ".claude-plugin", "plugin.json"),
			JSON.stringify({ name: "clickhouse", description: "ClickHouse tools" }),
		)
		write(
			path.join(repo, "skills", "best-practices", "SKILL.md"),
			"---\ndescription: Apply ClickHouse best practices\n---\nRead ${CLAUDE_PLUGIN_ROOT}/skills/best-practices/rules.md.\n",
		)
		write(path.join(repo, "skills", "best-practices", "rules.md"), "Prefer sparse primary keys.\n")
		write(path.join(repo, "commands", "status.md"), "---\ndescription: Show ClickHouse status\n---\nShow status.\n")
		write(path.join(repo, "agents", "dba.md"), "---\ndescription: Database agent\n---\nAct as a DBA.\n")
		write(
			path.join(repo, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					clickhouse: { command: "${CLAUDE_PLUGIN_ROOT}/bin/clickhouse-mcp", args: ["--safe"] },
				},
			}),
		)
		write(path.join(repo, "bin", "clickhouse-mcp"), "#!/bin/sh\n")

		execFileSync("git", ["init", "--quiet", repo])
		execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"])
		execFileSync("git", ["-C", repo, "config", "user.name", "Plugin Test"])
		execFileSync("git", ["-C", repo, "add", "."])
		execFileSync("git", ["-C", repo, "commit", "--quiet", "-m", "fixture"])
		const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()

		const plugin: MarketplacePlugin = {
			name: "clickhouse",
			description: "ClickHouse tools",
			source: { source: "url", url: repo, sha },
		}
		const installed = await installMarketplacePlugin(plugin, project)

		assert.equal(installed.name, "clickhouse")
		assert.deepEqual(installed.inventory, { skills: 1, commands: 1, agents: 1, mcpServers: 1, hooks: 0 })
		assert.equal(fs.readFileSync(path.join(installed.dir, "skills", "best-practices", "rules.md"), "utf8"), "Prefer sparse primary keys.\n")
		assert.deepEqual(listInstalledPlugins(project).map((entry) => entry.name), ["clickhouse"])

		const skills = loadSkills(project)
		assert(skills.has("clickhouse:best-practices"))
		assert(skills.has("clickhouse:status"))
		const instructions = renderSkillContent(skills.get("clickhouse:best-practices")!)
		assert(instructions.includes(`${installed.dir}/skills/best-practices/rules.md`))

		const mcp = loadMcpConfig(project)
		const server = mcp.servers.plugin_clickhouse_clickhouse
		assert(server)
		assert.equal(server.scope, "project")
		assert.equal(server.type, "stdio")
		if (server.type === "stdio") assert.equal(server.command, path.join(installed.dir, "bin", "clickhouse-mcp"))
	} finally {
		fs.rmSync(temp, { recursive: true, force: true })
	}
})
