import * as fs from "node:fs"
import * as path from "node:path"

import { getConfigDir } from "../config/settings.js"
import { installedPluginDirs } from "../plugins/manager.js"
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
function loadSkill(
	skillDir: string,
	source: "user" | "project" | "plugin",
	options: { skillFile?: string; name?: string; plugin?: string; pluginDir?: string } = {},
): Skill | undefined {
	const skillFile = options.skillFile ?? path.join(skillDir, "SKILL.md")
	let raw: string
	try {
		raw = fs.readFileSync(skillFile, "utf8")
	} catch {
		return undefined
	}
	const { frontmatter, content } = parseFrontmatter(raw)
	const baseName = options.name || frontmatter.name || path.basename(skillDir)
	const name = options.plugin ? `${options.plugin}:${baseName}` : baseName
	return {
		name,
		description: frontmatter.description || descriptionFromBody(content),
		whenToUse: frontmatter.when_to_use,
		content,
		source,
		dir: skillDir,
		plugin: options.plugin,
		pluginDir: options.pluginDir,
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

/** Walk from cwd up to root, collecting `.orbcode/skills` and `.orb/skills`
 *  dirs (root last). `.orbcode` is pushed before `.orb` at each level so
 *  `.orb` wins on same-level name collisions. */
function projectSkillsDirs(cwd: string): string[] {
	const dirs: string[] = []
	let current = path.resolve(cwd)
	const root = path.parse(current).root
	while (current !== root) {
		// .orbcode/skills is legacy; .orb/skills is the current convention.
		// Push legacy first so .orb wins on same-level name collisions.
		dirs.push(path.join(current, ".orbcode", "skills"))
		dirs.push(path.join(current, ".orb", "skills"))
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

	// Marketplace plugins are self-contained bundles. Their skills and legacy
	// commands are exposed under a plugin namespace to prevent collisions.
	for (const pluginDir of installedPluginDirs(cwd)) {
		for (const skill of loadPluginSkills(pluginDir)) {
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
	return skill.content
		.replace(/\$\{SKILL_DIR\}/g, skill.dir)
		.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, skill.pluginDir ?? skill.dir)
		.replace(/\$\{ORB_PLUGIN_ROOT\}/g, skill.pluginDir ?? skill.dir)
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>
	} catch {
		return undefined
	}
}

function stringPaths(value: unknown): string[] {
	if (typeof value === "string") return [value]
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function safePluginPath(pluginDir: string, relativePath: string): string | undefined {
	const root = path.resolve(pluginDir)
	const target = path.resolve(root, relativePath)
	return target === root || target.startsWith(root + path.sep) ? target : undefined
}

function findFiles(root: string, predicate: (filePath: string) => boolean): string[] {
	let entries: fs.Dirent[]
	try {
		entries = fs.readdirSync(root, { withFileTypes: true })
	} catch {
		return []
	}
	const files: string[] = []
	for (const entry of entries) {
		const item = path.join(root, entry.name)
		if (entry.isDirectory()) files.push(...findFiles(item, predicate))
		else if (entry.isFile() && predicate(item)) files.push(item)
	}
	return files
}

/** Load skills and legacy command files from one installed plugin bundle. */
function loadPluginSkills(pluginDir: string): Skill[] {
	const metadata = readJson(path.join(pluginDir, ".orb-plugin.json"))
	const manifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"))
	const pluginName =
		(typeof metadata?.name === "string" && metadata.name) ||
		(typeof manifest?.name === "string" && manifest.name) ||
		path.basename(pluginDir)
	const skillFiles = new Set<string>()
	const commandFiles = new Set<string>()

	const rootSkill = path.join(pluginDir, "SKILL.md")
	if (fs.existsSync(rootSkill)) skillFiles.add(rootSkill)
	for (const file of findFiles(path.join(pluginDir, "skills"), (item) => path.basename(item) === "SKILL.md")) {
		skillFiles.add(file)
	}

	// Marketplace and manifest skill paths add to the default skills scan.
	for (const relative of [...stringPaths(metadata?.skills), ...stringPaths(manifest?.skills)]) {
		const target = safePluginPath(pluginDir, relative)
		if (!target) continue
		try {
			if (fs.statSync(target).isFile() && path.basename(target) === "SKILL.md") skillFiles.add(target)
			else if (fs.statSync(target).isDirectory()) {
				for (const file of findFiles(target, (item) => path.basename(item) === "SKILL.md")) skillFiles.add(file)
			}
		} catch {
			// Invalid optional component paths do not prevent other skills loading.
		}
	}

	for (const file of findFiles(path.join(pluginDir, "commands"), (item) => item.toLowerCase().endsWith(".md"))) {
		commandFiles.add(file)
	}
	for (const relative of [...stringPaths(metadata?.commands), ...stringPaths(manifest?.commands)]) {
		const target = safePluginPath(pluginDir, relative)
		if (!target) continue
		try {
			if (fs.statSync(target).isFile() && target.toLowerCase().endsWith(".md")) commandFiles.add(target)
			else if (fs.statSync(target).isDirectory()) {
				for (const file of findFiles(target, (item) => item.toLowerCase().endsWith(".md"))) commandFiles.add(file)
			}
		} catch {
			// Ignore invalid optional command paths.
		}
	}

	const skills: Skill[] = []
	for (const file of skillFiles) {
		const skill = loadSkill(path.dirname(file), "plugin", { skillFile: file, plugin: pluginName, pluginDir })
		if (skill) skills.push(skill)
	}
	for (const file of commandFiles) {
		const name = path.basename(file, path.extname(file))
		const skill = loadSkill(path.dirname(file), "plugin", {
			skillFile: file,
			name,
			plugin: pluginName,
			pluginDir,
		})
		if (skill) skills.push(skill)
	}
	return skills
}
