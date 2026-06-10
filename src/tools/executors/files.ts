import * as fs from "node:fs"
import * as path from "node:path"

import { type ToolContext, type ToolResult, resolveWorkspacePath } from "../types.js"
import { unifiedDiff } from "../../utils/diff.js"

const MAX_READ_LINES = 1000

/** Format file content as right-aligned `LINE_NUMBER|LINE_CONTENT` (6-char padding). */
function withLineNumbers(lines: string[], startLine: number): string {
	return lines.map((line, i) => `${String(startLine + i).padStart(6, " ")}|${line}`).join("\n")
}

export async function readFile(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const filePath = resolveWorkspacePath(context.cwd, String(args.file_path ?? ""))
	const offset = Math.max(1, Number(args.offset ?? 1) || 1)
	const limitArg = args.limit === null || args.limit === undefined ? MAX_READ_LINES : Number(args.limit)
	const limit = Math.min(Math.max(1, limitArg || MAX_READ_LINES), MAX_READ_LINES)

	let content: string
	try {
		content = fs.readFileSync(filePath, "utf8")
	} catch (error) {
		return { text: `Error reading file ${filePath}: ${(error as Error).message}`, isError: true }
	}

	const allLines = content.split("\n")
	const slice = allLines.slice(offset - 1, offset - 1 + limit)
	if (slice.length === 0) {
		return { text: `File ${filePath} has ${allLines.length} lines; offset ${offset} is beyond the end.`, isError: true }
	}

	let result = withLineNumbers(slice, offset)
	const lastLineShown = offset - 1 + slice.length
	if (lastLineShown < allLines.length) {
		result += `\n\n(Showing lines ${offset}-${lastLineShown} of ${allLines.length}. Use offset/limit to read more.)`
	}
	return { text: result }
}

export async function fileWrite(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const filePath = resolveWorkspacePath(context.cwd, String(args.file_path ?? ""))
	const content = String(args.content ?? "")
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true })
		fs.writeFileSync(filePath, content)
	} catch (error) {
		return { text: `Error writing file ${filePath}: ${(error as Error).message}`, isError: true }
	}
	return { text: `Successfully wrote ${content.split("\n").length} lines to ${filePath}.` }
}

interface EditSpec {
	file_path: string
	old_string: string
	new_string: string
	replace_all?: boolean | string
}

/** The model may send replace_all as a boolean or a string ("true"/"1"). */
function parseReplaceAll(value: unknown): boolean {
	return value === true || value === "true" || value === "1"
}

function applyEdit(content: string, edit: EditSpec): { content: string; error?: string } {
	const { old_string, new_string } = edit
	const replace_all = parseReplaceAll(edit.replace_all)
	if (old_string === new_string) {
		return { content, error: "old_string and new_string are identical" }
	}
	if (old_string === "") {
		// Empty old_string replaces the entire file.
		return { content: new_string }
	}
	const occurrences = content.split(old_string).length - 1
	if (occurrences === 0) {
		return { content, error: "old_string not found in file" }
	}
	if (occurrences > 1 && !replace_all) {
		return {
			content,
			error: `old_string matched ${occurrences} times; provide more context for a unique match or set replace_all to true`,
		}
	}
	return { content: content.split(old_string).join(new_string) }
}

function editOneFile(cwd: string, edits: EditSpec[]): string[] {
	const filePath = resolveWorkspacePath(cwd, edits[0].file_path)
	let content: string
	try {
		content = fs.readFileSync(filePath, "utf8")
	} catch (error) {
		return edits.map(() => `FAILED ${filePath}: ${(error as Error).message}`)
	}

	const results: string[] = []
	let changed = false
	for (const edit of edits) {
		const { content: next, error } = applyEdit(content, edit)
		if (error) {
			results.push(`FAILED ${filePath}: ${error}`)
		} else {
			content = next
			changed = true
			results.push(`OK ${filePath}: replaced "${truncate(edit.old_string || "(entire file)", 60)}"`)
		}
	}
	if (changed) {
		try {
			fs.writeFileSync(filePath, content)
		} catch (error) {
			return edits.map(() => `FAILED ${filePath}: ${(error as Error).message}`)
		}
	}
	return results
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\n/g, "\\n")
	return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine
}

export async function fileEdit(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const edit: EditSpec = {
		file_path: String(args.file_path ?? ""),
		old_string: String(args.old_string ?? ""),
		new_string: String(args.new_string ?? ""),
		replace_all: parseReplaceAll(args.replace_all),
	}
	const [result] = editOneFile(context.cwd, [edit])
	return { text: result, isError: result.startsWith("FAILED") }
}

/**
 * Compute the diff a file-modifying tool call would produce, without writing
 * anything. Returns undefined when no diff can be computed (e.g. the edit will
 * fail to match); the executor surfaces the real error in that case.
 */
export function previewFileChange(
	toolName: string,
	args: Record<string, unknown>,
	cwd: string,
): string | undefined {
	try {
		if (toolName === "file_write") {
			const relPath = String(args.file_path ?? "")
			const filePath = resolveWorkspacePath(cwd, relPath)
			let oldContent = ""
			try {
				oldContent = fs.readFileSync(filePath, "utf8")
			} catch {
				// new file
			}
			const diff = unifiedDiff(oldContent, String(args.content ?? ""))
			return diff ? `${relPath}\n${diff}` : undefined
		}

		const edits: EditSpec[] =
			toolName === "file_edit"
				? [
						{
							file_path: String(args.file_path ?? ""),
							old_string: String(args.old_string ?? ""),
							new_string: String(args.new_string ?? ""),
							replace_all: parseReplaceAll(args.replace_all),
						},
					]
				: ((Array.isArray(args.edits) ? args.edits : []) as EditSpec[])
		if (edits.length === 0) return undefined

		const byFile = new Map<string, EditSpec[]>()
		for (const edit of edits) {
			const key = edit.file_path
			if (!byFile.has(key)) byFile.set(key, [])
			byFile.get(key)!.push(edit)
		}

		const parts: string[] = []
		for (const [relPath, fileEdits] of byFile) {
			const filePath = resolveWorkspacePath(cwd, relPath)
			const oldContent = fs.readFileSync(filePath, "utf8")
			let content = oldContent
			for (const edit of fileEdits) {
				const { content: next, error } = applyEdit(content, edit)
				if (error) return undefined
				content = next
			}
			const diff = unifiedDiff(oldContent, content)
			if (diff) parts.push(`${relPath}\n${diff}`)
		}
		return parts.length > 0 ? parts.join("\n") : undefined
	} catch {
		return undefined
	}
}

export async function multiFileEdit(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const edits = (Array.isArray(args.edits) ? args.edits : []) as EditSpec[]
	if (edits.length === 0) {
		return { text: "FAILED: edits array is empty", isError: true }
	}

	// Group edits by file, preserving order within each file.
	const byFile = new Map<string, EditSpec[]>()
	for (const edit of edits) {
		const key = resolveWorkspacePath(context.cwd, edit.file_path)
		if (!byFile.has(key)) byFile.set(key, [])
		byFile.get(key)!.push(edit)
	}

	const results: string[] = []
	for (const fileEdits of byFile.values()) {
		results.push(...editOneFile(context.cwd, fileEdits))
	}
	const anyFailed = results.some((r) => r.startsWith("FAILED"))
	return { text: results.join("\n"), isError: anyFailed && results.every((r) => r.startsWith("FAILED")) }
}
