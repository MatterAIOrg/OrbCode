import * as fs from "node:fs"
import * as path from "node:path"
import picomatch from "picomatch"

import { type ToolContext, type ToolResult, resolveWorkspacePath } from "../types.js"

const IGNORED_DIRS = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	"__pycache__",
	".venv",
	"venv",
])

const MAX_RESULTS = 300
const MAX_FILE_SIZE = 2 * 1024 * 1024 // skip files over 2MB
const MAX_LINE_LENGTH = 500

export async function searchFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const dirPath = resolveWorkspacePath(context.cwd, String(args.path ?? "."))
	const regexSource = String(args.regex ?? "")
	const filePattern = args.file_pattern == null || args.file_pattern === "" ? null : String(args.file_pattern)

	let regex: RegExp
	try {
		regex = new RegExp(regexSource)
	} catch (error) {
		return { text: `Invalid regex: ${(error as Error).message}`, isError: true }
	}

	if (!fs.existsSync(dirPath)) {
		return { text: `Directory not found: ${dirPath}`, isError: true }
	}

	// A bare pattern like "*.ts" should match at any depth, like ripgrep -g.
	const isMatch = filePattern
		? picomatch(filePattern.includes("/") ? filePattern : `**/${filePattern}`, { dot: true })
		: () => true

	const results: string[] = []
	let matchCount = 0

	const walk = (dir: string): void => {
		if (matchCount >= MAX_RESULTS) return
		let dirents: fs.Dirent[]
		try {
			dirents = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			return
		}
		for (const dirent of dirents) {
			if (matchCount >= MAX_RESULTS) return
			const full = path.join(dir, dirent.name)
			if (dirent.isDirectory()) {
				if (!IGNORED_DIRS.has(dirent.name) && !dirent.name.startsWith(".")) walk(full)
				continue
			}
			// picomatch only understands forward slashes, so normalize Windows paths.
			const rel = path.relative(dirPath, full).split(path.sep).join("/")
			if (!isMatch(rel)) continue
			let stat: fs.Stats
			try {
				stat = fs.statSync(full)
			} catch {
				continue
			}
			if (stat.size > MAX_FILE_SIZE) continue

			let content: string
			try {
				content = fs.readFileSync(full, "utf8")
			} catch {
				continue
			}
			if (content.includes("\u0000")) continue // binary

			const lines = content.split("\n")
			const fileMatches: string[] = []
			for (let i = 0; i < lines.length && matchCount < MAX_RESULTS; i++) {
				if (regex.test(lines[i])) {
					matchCount++
					const lineText = lines[i].length > MAX_LINE_LENGTH ? lines[i].slice(0, MAX_LINE_LENGTH) + "…" : lines[i]
					fileMatches.push(`  ${i + 1}: ${lineText}`)
				}
			}
			if (fileMatches.length > 0) {
				results.push(`${rel}\n${fileMatches.join("\n")}`)
			}
		}
	}

	walk(dirPath)

	if (results.length === 0) {
		return { text: `No matches found for "${regexSource}" in ${dirPath}.` }
	}

	let text = `Found ${matchCount} match${matchCount === 1 ? "" : "es"}:\n\n${results.join("\n\n")}`
	if (matchCount >= MAX_RESULTS) {
		text += `\n\n(Truncated at ${MAX_RESULTS} matches. Narrow your regex or file_pattern.)`
	}
	return { text }
}
