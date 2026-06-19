import * as fs from "node:fs"
import * as path from "node:path"

import { getConfigDir } from "../config/settings.js"
import type { ParsedFrontmatter, Skill } from "./types.js"

/**
 * Skill loader.
 *
 * Skills are markdown files that inject specialized instructions when the model
 * invokes the `use_skill` tool. Discovery mirrors Claude Code's layout:
 *
 *   - User skills:   ~/.orbcode/skills/<name>/SKILL.md
 *   - Project skills: .orbcode/skills/<name>/SKILL.md (in cwd and parents)
 *
 * Only the directory format (`<name>/SKILL.md`) is supported, matching Claude
 * Code's current skills/ convention. Project skills override user skills on
 * name collisions (closer-to-cwd wins).
 */

/** Parse a leading `---\n...---\n` YAML frontmatter block. */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
	if (!match) return { frontmatter: {}, content: raw }
	const [, yamlBlock, body] = match
	const frontmatter: Record<string, string> = {}
	for (const line of yamlBlock.split(/\r?\n/)) {
		const idx = line.indexOf(":")
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "")
		if (key) frontmatter[key] = value
	}
	return { frontmatter, content: body.trimStart() }
}

/** Extract a description from the first markdown paragraph if frontmatter lacks one. */
function descriptionFromBody(content: string): string {
	const text = content
		.replace(/^#+\s.*$/gm, "")
		.replace(/```[\s\S]*?```/g, "")
		.trim()
	const firstPara = text.split(/\n\s*\n/)[0] ?? ""
	return firstPara.replace(/\s+/g, " ").trim().slice(0, 160)
}

/** Load a single skill from a `<dir>/SKILL.md` path. */
function loadSkill(skillDir: string, source: "user" | "project"): Skill | undefined {
	const skillFile = path.join(skillDir, "SKILL.md")
	let raw: string
	try {
		raw = fs.readFileSync(skillFile, "utf8")
	} catch {
		return undefined
	}
	const name = path.basename(skillDir)
	const { frontmatter, content } = parseFrontmatter(raw)
	return {
		name,
		description: frontmatter.description || descriptionFromBody(content),
		whenToUse: frontmatter.when_to_use,
		content,
		source,
		dir: skillDir,
	}
}

/** Load all skills from a `skills/` directory (each subdirectory is one skill). */
function loadSkillsDir(skillsDir: string, source: "user" | "project"): Skill[] {
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(skillsDir, { withFileTypes: true })
	} catch {
		return []
	}
	const skills: Skill[] = []
	for (const entry of entries) {
		if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
		const skill = loadSkill(path.join(skillsDir, entry.name), source)
		if (skill) skills.push(skill)
	}
	return skills
}

/** Walk from cwd up to root, collecting `.orbcode/skills` dirs (root last). */
function projectSkillsDirs(cwd: string): string[] {
	const dirs: string[] = []
	let current = path.resolve(cwd)
	const root = path.parse(current).root
	while (current !== root) {
		dirs.push(path.join(current, ".orbcode", "skills"))
		const parent = path.dirname(current)
		if (parent === current) break
		current = parent
	}
	return dirs
}

/**
 * Load all skills. Project skills (closer-to-cwd) override user skills on name
 * collisions. Returns a map keyed by skill name.
 */
export function loadSkills(cwd = process.cwd()): Map<string, Skill> {
	const skills = new Map<string, Skill>()

	// User skills first (lowest precedence).
	for (const skill of loadSkillsDir(path.join(getConfigDir(), "skills"), "user")) {
		skills.set(skill.name, skill)
	}

	// Project skills, root -> cwd so cwd wins.
	for (const dir of projectSkillsDirs(cwd).reverse()) {
		for (const skill of loadSkillsDir(dir, "project")) {
			skills.set(skill.name, skill)
		}
	}

	return skills
}

/** Render the skill catalog for the system prompt (names + when_to_use). */
export function renderSkillCatalog(skills: Map<string, Skill>): string {
	if (skills.size === 0) return ""
	const lines = ["# Available Skills", ""]
	for (const skill of skills.values()) {
		const when = skill.whenToUse ? ` — use when: ${skill.whenToUse}` : ""
		lines.push(`- \`${skill.name}\`: ${skill.description}${when}`)
	}
	lines.push("")
	lines.push("Use the `use_skill` tool with a `skill_name` to load a skill's full instructions.")
	return lines.join("\n")
}

/** Substitute ${SKILL_DIR} in a skill's content with its directory path. */
export function renderSkillContent(skill: Skill): string {
	return skill.content.replace(/\$\{SKILL_DIR\}/g, skill.dir)
}
