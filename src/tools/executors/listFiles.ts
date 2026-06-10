import * as fs from "node:fs"
import * as path from "node:path"

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

const MAX_ENTRIES = 800

export function walkFiles(root: string, recursive: boolean, maxEntries: number = MAX_ENTRIES): string[] {
	const entries: string[] = []
	const queue: string[] = [root]

	while (queue.length > 0 && entries.length < maxEntries) {
		const dir = queue.shift()!
		let dirents: fs.Dirent[]
		try {
			dirents = fs.readdirSync(dir, { withFileTypes: true })
		} catch {
			continue
		}
		dirents.sort((a, b) => a.name.localeCompare(b.name))
		for (const dirent of dirents) {
			if (entries.length >= maxEntries) break
			const full = path.join(dir, dirent.name)
			// Always report forward-slash paths: the UI (@-mention filtering) and
			// the model both treat "/" as the separator, even on Windows.
			const rel = path.relative(root, full).split(path.sep).join("/")
			if (dirent.isDirectory()) {
				entries.push(rel + "/")
				if (recursive && !IGNORED_DIRS.has(dirent.name) && !dirent.name.startsWith(".")) {
					queue.push(full)
				}
			} else {
				entries.push(rel)
			}
		}
	}
	return entries
}

export async function listFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const dirPath = resolveWorkspacePath(context.cwd, String(args.path ?? "."))
	const recursive = Boolean(args.recursive)

	if (!fs.existsSync(dirPath)) {
		return { text: `Directory not found: ${dirPath}`, isError: true }
	}

	const entries = walkFiles(dirPath, recursive)
	if (entries.length === 0) {
		return { text: `Directory ${dirPath} is empty.` }
	}
	let text = entries.join("\n")
	if (entries.length >= MAX_ENTRIES) {
		text += `\n\n(Truncated at ${MAX_ENTRIES} entries.)`
	}
	return { text }
}
