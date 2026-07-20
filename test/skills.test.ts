import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"

import { loadSkillFromPath } from "../src/skills/loader.js"
import { useSkill } from "../src/tools/executors/skills.js"
import type { ToolContext } from "../src/tools/types.js"

function writeSkill(skillDir: string): string {
	const skillFile = path.join(skillDir, "SKILL.md")
	fs.mkdirSync(skillDir, { recursive: true })
	fs.writeFileSync(
		skillFile,
		"---\nname: external-review\ndescription: Review external changes\n---\nRead ${SKILL_DIR}/rules.md.\n",
	)
	return skillFile
}

test("loads an external skill from a directory or SKILL.md path", () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-skills-test-"))
	try {
		const skillDir = path.join(workspace, "shared-skills", "review")
		const skillFile = writeSkill(skillDir)

		assert.equal(loadSkillFromPath(skillDir, workspace)?.name, "external-review")
		assert.equal(loadSkillFromPath(skillFile, workspace)?.dir, skillDir)
		assert.equal(loadSkillFromPath(path.relative(workspace, skillDir), workspace)?.name, "external-review")
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true })
	}
})

test("use_skill accepts an explicit path outside the discovery catalog", async () => {
	const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-skills-test-"))
	try {
		const skillDir = path.join(workspace, "shared-skills", "review")
		writeSkill(skillDir)

		const result = await useSkill(
			{ skill_name: path.relative(workspace, skillDir) },
			{ cwd: workspace } as ToolContext,
		)

		assert.equal(result.isError, undefined)
		assert.match(result.text, /# Skill: external-review/)
		assert.match(result.text, new RegExp(`${skillDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/rules\\.md`))
	} finally {
		fs.rmSync(workspace, { recursive: true, force: true })
	}
})
