import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { getConfigDir } from "../config/settings.js"
import type { MemoryFile } from "./types.js"

/**
 * AGENTS.md memory loader.
 *
 * OrbCode's memory system mirrors Claude Code's CLAUDE.md discovery, but uses
 * the open `AGENTS.md` filename (the cross-tool standard) instead of a
 * vendor-specific name. Files are loaded in this order (lowest precedence
 * first), with closer-to-cwd and higher-precedence types winning:
 *
 *   1. User memory:   ~/.orbcode/AGENTS.md
 *   2. Project memory: AGENTS.md and .orbcode/AGENTS.md in cwd and every
 *      parent directory (closer-to-cwd wins)
 *   3. Local memory:   AGENTS.local.md in cwd and parents (highest precedence)
 *
 * Memory files support `@path` include directives (relative, `~/`, or
 * absolute) to pull in other files. Includes are resolved recursively up to a
 * small depth limit, with cycle detection.
 */

const MAX_INCLUDE_DEPTH = 5
const MAX_TOTAL_CHARS = 200_000

/** Read a file as UTF-8, returning undefined if it's missing or unreadable. */
function readText(filePath: string): string | undefined {
	try {
		return fs.readFileSync(filePath, "utf8")
	} catch {
		return undefined
	}
}

/** Resolve an @include path relative to the including file's directory. */
function resolveInclude(ref: string, baseDir: string): string {
	if (ref.startsWith("~/")) return path.join(os.homedir(), ref.slice(2))
	if (path.isAbsolute(ref)) return ref
	return path.resolve(baseDir, ref)
}

/**
 * Extract `@path` references from leaf text (not inside code spans/blocks).
 * A simple, conservative parser: skips fenced code blocks and inline code.
 */
function extractIncludes(content: string, baseDir: string): string[] {
	const refs: string[] = []
	let inFence = false
	for (const line of content.split(/\r?\n/)) {
		if (/^```/.test(line.trim())) {
			inFence = !inFence
			continue
		}
		if (inFence) continue
		// Strip inline code spans before scanning for @refs.
		const stripped = line.replace(/`[^`]*`/g, "")
		const regex = /(?:^|\s)@((?:\.\/|~\/|\/)?[^\s]+)/g
		let match: RegExpExecArray | null
		while ((match = regex.exec(stripped)) !== null) {
			const ref = match[1].replace(/\\ /g, " ")
			// Avoid matching emails, @mentions, etc.
			if (!/^[A-Za-z0-9._~/-]/.test(ref)) continue
			refs.push(resolveInclude(ref, baseDir))
		}
	}
	return refs
}

/** Recursively load a memory file and all its @includes. */
function loadWithIncludes(
	filePath: string,
	type: MemoryFile["type"],
	processed: Set<string>,
	depth: number,
): MemoryFile[] {
	const real = safeRealpath(filePath)
	if (processed.has(real) || depth >= MAX_INCLUDE_DEPTH) return []
	const raw = readText(filePath)
	if (raw === undefined) return []
	processed.add(real)

	const baseDir = path.dirname(filePath)
	const includePaths = extractIncludes(raw, baseDir)
	const results: MemoryFile[] = []

	// Includes come first (so they appear before the including file's content).
	for (const includePath of includePaths) {
		results.push(...loadWithIncludes(includePath, type, processed, depth + 1))
	}

	results.push({ path: filePath, content: raw, type })
	return results
}

/** realpathSync that never throws (falls back to the input path). */
function safeRealpath(p: string): string {
	try {
		return fs.realpathSync(p)
	} catch {
		return path.resolve(p)
	}
}

/** Walk from cwd up to root, collecting directories (root last). */
function ancestorDirs(cwd: string): string[] {
	const dirs: string[] = []
	let current = path.resolve(cwd)
	const root = path.parse(current).root
	while (current !== root) {
		dirs.push(current)
		const parent = path.dirname(current)
		if (parent === current) break
		current = parent
	}
	return dirs
}

/**
 * Load all AGENTS.md memory files, in precedence order (lowest first). The
 * caller concatenates them in order so higher-precedence files appear last
 * (and thus get more weight from the model).
 */
export function loadMemoryFiles(cwd = process.cwd()): MemoryFile[] {
	const processed = new Set<string>()
	const files: MemoryFile[] = []

	// 1. User memory (~/.orbcode/AGENTS.md)
	files.push(...loadWithIncludes(path.join(getConfigDir(), "AGENTS.md"), "user", processed, 0))

	// 2. Project memory (AGENTS.md + .orbcode/AGENTS.md), root -> cwd
	for (const dir of ancestorDirs(cwd).reverse()) {
		files.push(...loadWithIncludes(path.join(dir, "AGENTS.md"), "project", processed, 0))
		files.push(...loadWithIncludes(path.join(dir, ".orbcode", "AGENTS.md"), "project", processed, 0))
	}

	// 3. Local memory (AGENTS.local.md), root -> cwd — highest precedence
	for (const dir of ancestorDirs(cwd).reverse()) {
		files.push(...loadWithIncludes(path.join(dir, "AGENTS.local.md"), "local", processed, 0))
	}

	return files
}

/** Render the memory files into a single system-prompt section. */
export function renderMemorySection(files: MemoryFile[]): string {
	const valid = files.filter((f) => f.content.trim())
	if (valid.length === 0) return ""
	const parts: string[] = [
		"# Project & User Instructions (AGENTS.md)",
		"",
		"Instructions from AGENTS.md files are shown below. Adhere to these instructions; they override default behavior. Treat them as authoritative guidance from the user about this codebase.",
		"",
	]
	let total = 0
	for (const file of valid) {
		if (total >= MAX_TOTAL_CHARS) {
			parts.push("… (remaining memory files truncated to stay within context budget)")
			break
		}
		const label = labelFor(file)
		parts.push(`## ${label}: \`${file.path}\``)
		parts.push("")
		parts.push(file.content.trim())
		parts.push("")
		total += file.content.length
	}
	return parts.join("\n")
}

function labelFor(file: MemoryFile): string {
	switch (file.type) {
		case "user":
			return "User memory"
		case "project":
			return "Project memory"
		case "local":
			return "Local memory"
	}
}
