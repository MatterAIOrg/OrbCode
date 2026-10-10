import * as fs from "node:fs"
import * as path from "node:path"

import { type ToolContext, type ToolResult, resolveWorkspacePath } from "../types.js"
import { unifiedDiff } from "../../utils/diff.js"

const MAX_READ_LINES = 1000
const MIN_READ_LINES = 200
/** Line limits don't bound minified or generated files (one line can be megabytes). */
const MAX_READ_CHARS_PER_FILE = 100_000
const MAX_READ_CHARS_PER_CALL = 200_000
const MIN_READ_BUDGET_CHARS = 1_000

/** Format file content as right-aligned `LINE_NUMBER|LINE_CONTENT` (6-char padding). */
function withLineNumbers(lines: string[], startLine: number): string {
	return lines.map((line, i) => `${String(startLine + i).padStart(6, " ")}|${line}`).join("\n")
}

interface FileReadSpec {
	file_path: string
	offset?: number
	limit?: number
}

function parseFileEntries(args: Record<string, unknown>): FileReadSpec[] {
	if (Array.isArray(args.files) && args.files.length > 0) {
		return args.files.map((item: Record<string, unknown>) => {
			const offset = item.offset != null ? Math.max(1, Number(item.offset) || 1) : undefined
			let limit: number | undefined
			if (item.limit != null) {
				const rawLimit = Number(item.limit)
				if (!isNaN(rawLimit)) {
					limit = Math.min(MAX_READ_LINES, Math.max(MIN_READ_LINES, rawLimit))
				}
			}
			return {
				file_path: String(item.file_path ?? ""),
				offset,
				limit,
			}
		})
	} else if (args.file_path) {
		const offset = args.offset != null ? Math.max(1, Number(args.offset) || 1) : undefined
		let limit: number | undefined
		if (args.limit != null) {
			const rawLimit = Number(args.limit)
			if (!isNaN(rawLimit)) {
				limit = Math.min(MAX_READ_LINES, Math.max(1, rawLimit))
			}
		}
		return [
			{
				file_path: String(args.file_path),
				offset,
				limit,
			},
		]
	}
	return []
}

export async function readFile(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const entries = parseFileEntries(args)
	if (entries.length === 0) {
		return { text: "No files specified to read.", isError: true }
	}

	const results: { text: string; isError?: boolean }[] = []
	let charsReturned = 0

	for (const entry of entries) {
		const relPath = entry.file_path
		const filePath = resolveWorkspacePath(context.cwd, relPath)
		const offset = entry.offset ?? 1
		const limit = entry.limit ?? MAX_READ_LINES

		let content: string
		try {
			content = fs.readFileSync(filePath, "utf8")
		} catch (error) {
			results.push({
				text: `Error reading file ${relPath}: ${(error as Error).message}`,
				isError: true,
			})
			continue
		}

		const allLines = content.split("\n")
		const totalLines = allLines.length
		const slice = allLines.slice(offset - 1, offset - 1 + limit)

		if (slice.length === 0 && totalLines > 0) {
			results.push({
				text: `File ${relPath} has ${totalLines} lines; offset ${offset} is beyond the end.`,
				isError: true,
			})
			continue
		}

		const budget = Math.min(MAX_READ_CHARS_PER_FILE, MAX_READ_CHARS_PER_CALL - charsReturned)
		// A sliver of leftover budget would return a useless fragment.
		if (budget < MIN_READ_BUDGET_CHARS) {
			results.push({
				text: `Skipped ${relPath}: this call reached its ${MAX_READ_CHARS_PER_CALL}-character limit. Read it in a separate call.`,
				isError: true,
			})
			continue
		}
		let formattedContent = withLineNumbers(slice, offset)
		let lastLineShown = offset - 1 + slice.length
		let capNote = ""
		if (formattedContent.length > budget) {
			// Whole lines when possible; a single line longer than the budget is cut mid-line.
			const lineEnd = formattedContent.lastIndexOf("\n", budget)
			formattedContent = lineEnd > 0 ? formattedContent.slice(0, lineEnd) : formattedContent.slice(0, budget)
			lastLineShown = offset - 1 + formattedContent.split("\n").length
			capNote =
				lineEnd > 0
					? `Output capped at ${budget} characters; showing through line ${lastLineShown}. Use offset/limit to read more.`
					: `Line ${lastLineShown} alone exceeds ${budget} characters and was cut off. Use Bash (e.g. head -c, cut -c) to read part of it.`
		}
		charsReturned += formattedContent.length

		if (entries.length === 1) {
			let output = formattedContent
			if (capNote) {
				output += `\n\n(${capNote})`
			} else if (lastLineShown < totalLines) {
				output += `\n\n(Showing lines ${offset}-${lastLineShown} of ${totalLines}. Use offset/limit to read more.)`
			}
			results.push({ text: output })
		} else {
			const rangeLabel = totalLines > 0 ? ` (lines ${offset}-${lastLineShown} of ${totalLines})` : ""
			let output = `--- ${relPath}${rangeLabel} ---\n${formattedContent}`
			if (capNote) {
				output += `\n(${capNote})`
			} else if (lastLineShown < totalLines) {
				output += `\n(Showing lines ${offset}-${lastLineShown} of ${totalLines}. Use offset/limit to read more.)`
			}
			results.push({ text: output })
		}
	}

	const combinedText = results.map((r) => r.text).join("\n\n")
	const allFailed = results.length > 0 && results.every((r) => r.isError)

	return {
		text: combinedText,
		isError: allFailed,
	}
}

/**
 * Why a write/edit target is unusable, phrased so the model can recover. An
 * empty file_path would otherwise resolve to the cwd and fail with EISDIR.
 */
function targetPathError(rawPath: string, filePath: string): string | undefined {
	if (!rawPath.trim()) {
		return "file_path is missing. The tool call arguments were likely cut off before file_path was sent (e.g. the output limit was reached mid-call). Re-issue the call with file_path set; for very large files, write a first part with file_write and append the rest with file_edit."
	}
	try {
		if (fs.statSync(filePath).isDirectory()) {
			return `${filePath} is a directory; file_path must name a file.`
		}
	} catch {
		// Missing path: a new file.
	}
	return undefined
}

export async function fileWrite(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const rawPath = String(args.file_path ?? "")
	const filePath = resolveWorkspacePath(context.cwd, rawPath)
	const content = String(args.content ?? "")
	const pathError = targetPathError(rawPath, filePath)
	if (pathError) return { text: `Error writing file: ${pathError}`, isError: true }
	try {
		context.beforeWrite?.(filePath)
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

/** Result of applying one edit. `note` explains a non-exact match to the model. */
interface EditOutcome {
	content: string
	error?: string
	note?: string
}

/** The file's newline style: CRLF only when every line break is CRLF. */
function detectEol(content: string): "\n" | "\r\n" {
	const crlf = (content.match(/\r\n/g) ?? []).length
	const lf = (content.match(/\n/g) ?? []).length
	return crlf > 0 && crlf === lf ? "\r\n" : "\n"
}

function toEol(text: string, eol: "\n" | "\r\n"): string {
	const normalized = text.replace(/\r\n/g, "\n")
	return eol === "\n" ? normalized : normalized.replace(/\n/g, eol)
}

function leadingWhitespace(line: string): string {
	return /^[ \t]*/.exec(line)![0]
}

/** Drop blank lines at both ends of the model's snippet. */
function trimBlankEdges(lines: string[]): string[] {
	let start = 0
	let end = lines.length
	while (start < end && lines[start].trim() === "") start++
	while (end > start && lines[end - 1].trim() === "") end--
	return lines.slice(start, end)
}

/**
 * Locate `oldLines` in the file line by line, ignoring indentation and trailing
 * whitespace. Returns the matched window only when it is unique.
 */
function findLooseMatch(fileLines: string[], oldLines: string[]): { start: number; count: number } | "ambiguous" | undefined {
	if (oldLines.length === 0) return undefined
	const wanted = oldLines.map((line) => line.trim())
	const matches: number[] = []
	for (let i = 0; i + wanted.length <= fileLines.length; i++) {
		let ok = true
		for (let j = 0; j < wanted.length; j++) {
			if (fileLines[i + j].trim() !== wanted[j]) {
				ok = false
				break
			}
		}
		if (ok) matches.push(i)
	}
	if (matches.length === 0) return undefined
	if (matches.length > 1) return "ambiguous"
	return { start: matches[0], count: wanted.length }
}

/** Re-indent the model's replacement text so it fits the file's indentation. */
function reindent(newLines: string[], oldLines: string[], fileWindow: string[]): string[] {
	const pairs = new Map<string, string>()
	const nonBlankOld = oldLines.filter((line) => line.trim() !== "")
	const nonBlankFile = fileWindow.filter((line) => line.trim() !== "")
	for (let i = 0; i < Math.min(nonBlankOld.length, nonBlankFile.length); i++) {
		const modelIndent = leadingWhitespace(nonBlankOld[i])
		if (!pairs.has(modelIndent)) pairs.set(modelIndent, leadingWhitespace(nonBlankFile[i]))
	}
	const modelBase = nonBlankOld.length > 0 ? leadingWhitespace(nonBlankOld[0]) : ""
	const fileBase = nonBlankFile.length > 0 ? leadingWhitespace(nonBlankFile[0]) : ""
	// Indent unit of the file, used to translate extra nesting the model added.
	const fileUnit = nonBlankFile.some((line) => line.startsWith("\t")) ? "\t" : "  "
	return newLines.map((line) => {
		if (line.trim() === "") return line
		const indent = leadingWhitespace(line)
		const mapped = pairs.get(indent)
		if (mapped !== undefined) return mapped + line.slice(indent.length)
		if (indent.startsWith(modelBase)) {
			const extra = indent.slice(modelBase.length)
			const levels = extra.includes("\t") ? extra.length : Math.round(extra.length / 2)
			return fileBase + fileUnit.repeat(levels) + line.slice(indent.length)
		}
		return fileBase + line.slice(indent.length)
	})
}

/** Up to 7 numbered lines around the file line that best resembles `oldString`. */
function closestRegion(content: string, oldString: string): string | undefined {
	const tokens = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9_$]+/g) ?? [])
	const probe = oldString.split("\n").find((line) => line.trim().length >= 4)
	if (!probe) return undefined
	const wanted = tokens(probe)
	if (wanted.size === 0) return undefined
	const lines = content.split("\n")
	let bestIndex = -1
	let bestScore = 0
	for (let i = 0; i < lines.length; i++) {
		const have = tokens(lines[i])
		let shared = 0
		for (const token of wanted) if (have.has(token)) shared++
		const score = shared / (wanted.size + have.size - shared || 1)
		if (score > bestScore) {
			bestScore = score
			bestIndex = i
		}
	}
	if (bestIndex < 0 || bestScore < 0.5) return undefined
	const from = Math.max(0, bestIndex - 3)
	const to = Math.min(lines.length, bestIndex + 4)
	const shown = lines
		.slice(from, to)
		.map((line, i) => `${String(from + i + 1).padStart(6, " ")}|${line.replace(/\r$/, "")}`)
		.join("\n")
	return `Closest match in the file (lines ${from + 1}-${to}, exact whitespace shown):\n${shown}`
}

function applyEdit(content: string, edit: EditSpec): EditOutcome {
	const replace_all = parseReplaceAll(edit.replace_all)
	if (edit.old_string === edit.new_string) {
		return { content, error: "old_string and new_string are identical" }
	}
	const eol = detectEol(content)
	// Keep the file's line endings consistent: replacement text follows the file.
	const new_string = toEol(edit.new_string, eol)
	if (edit.old_string === "") {
		// Empty old_string replaces the entire file.
		return { content: new_string }
	}

	// 1. Exact match, then the same text with the file's line endings.
	for (const candidate of new Set([edit.old_string, toEol(edit.old_string, eol)])) {
		const occurrences = content.split(candidate).length - 1
		if (occurrences === 0) continue
		if (occurrences > 1 && !replace_all) {
			return {
				content,
				error: `old_string matched ${occurrences} times; provide more context for a unique match or set replace_all to true`,
			}
		}
		return { content: content.split(candidate).join(new_string) }
	}

	// 2. Whitespace-tolerant line match (indentation / trailing space / tabs vs spaces).
	const fileLines = content.split(eol)
	const oldLines = trimBlankEdges(edit.old_string.replace(/\r\n/g, "\n").split("\n"))
	const loose = findLooseMatch(fileLines, oldLines)
	if (loose === "ambiguous") {
		return {
			content,
			error: "old_string matched multiple places once whitespace was ignored; include more surrounding lines to make it unique",
		}
	}
	if (loose) {
		const window = fileLines.slice(loose.start, loose.start + loose.count)
		const replacement = reindent(trimBlankEdges(new_string.split(eol)), oldLines, window)
		const next = [...fileLines.slice(0, loose.start), ...replacement, ...fileLines.slice(loose.start + loose.count)]
		return {
			content: next.join(eol),
			note: `matched ignoring whitespace differences at lines ${loose.start + 1}-${loose.start + loose.count}; verify the indentation with read_file if it matters`,
		}
	}

	const hint = closestRegion(content, edit.old_string)
	return { content, error: `old_string not found in file${hint ? `.\n${hint}` : ""}` }
}

function editOneFile(context: ToolContext, edits: EditSpec[]): string[] {
	const filePath = resolveWorkspacePath(context.cwd, edits[0].file_path)
	const pathError = targetPathError(String(edits[0].file_path ?? ""), filePath)
	if (pathError) return edits.map(() => `FAILED: ${pathError}`)
	let content: string
	try {
		content = fs.readFileSync(filePath, "utf8")
	} catch (error) {
		return edits.map(() => `FAILED ${filePath}: ${(error as Error).message}`)
	}

	const results: string[] = []
	let changed = false
	for (const edit of edits) {
		const { content: next, error, note } = applyEdit(content, edit)
		if (error) {
			results.push(`FAILED ${filePath}: ${error}`)
		} else {
			content = next
			changed = true
			results.push(
				`OK ${filePath}: replaced "${truncate(edit.old_string || "(entire file)", 60)}"${note ? ` (${note})` : ""}`,
			)
		}
	}
	if (changed) {
		try {
			context.beforeWrite?.(filePath)
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
	const [result] = editOneFile(context, [edit])
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
		results.push(...editOneFile(context, fileEdits))
	}
	const anyFailed = results.some((r) => r.startsWith("FAILED"))
	return { text: results.join("\n"), isError: anyFailed && results.every((r) => r.startsWith("FAILED")) }
}
