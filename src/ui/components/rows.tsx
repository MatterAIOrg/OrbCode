import React from "react"
import { Box, Text } from "../primitives.js"

import type { AttachmentSummary } from "../../attachments.js"
import { COLORS } from "../../branding.js"
import { isReadOnlyCommand } from "../../tools/readOnlyCommand.js"
import { renderMarkdown } from "../markdown.js"
import { Header } from "./Header.js"

export type Row =
	| { kind: "header"; id: string; cwd: string; modelName: string }
	| { kind: "user"; id: string; text: string; attachments?: AttachmentSummary[] }
	| { kind: "assistant"; id: string; text: string }
	| {
		kind: "tool"
		id: string
		name: string
		summary: string
		resultPreview: string
		isError: boolean
		diff?: string
	}
	/** A run of consecutive read-only tool calls collapsed into one summary line. */
	| { kind: "tool-group"; id: string; tools: GroupedTool[]; expanded: boolean }
	| { kind: "info"; id: string; text: string }
	| { kind: "error"; id: string; text: string }
	| { kind: "completion"; id: string; text: string }

export interface GroupedTool {
	name: string
	summary: string
}

/** Read-only exploration tools whose output the user rarely needs to see. */
const GROUPABLE_TOOLS = new Set([
	"read_file",
	"search_files",
	"codebase_search",
	"list_files",
	"list_code_definition_names",
	"lsp",
	"check_background",
	"web_search",
	"web_fetch",
])

/** Successful, diff-less observation calls collapse into the surrounding tool group. */
export function isGroupableTool(row: { name: string; summary: string; isError: boolean; diff?: string }): boolean {
	if (row.isError || row.diff) return false
	if (GROUPABLE_TOOLS.has(row.name)) return true
	return (row.name === "Bash" || row.name === "execute_command") && isReadOnlyCommand(row.summary)
}

/**
 * Append a row to the transcript, folding a groupable tool call into the tool
 * group directly before it (or starting a new one). Any other row — assistant
 * text, an edit, an error — ends the group, so each group covers one
 * uninterrupted stretch of exploration.
 */
export function appendRow(rows: Row[], row: Row, expanded: boolean): Row[] {
	if (row.kind !== "tool" || !isGroupableTool(row)) return [...rows, row]
	const tool: GroupedTool = { name: row.name, summary: row.summary }
	const last = rows[rows.length - 1]
	if (last?.kind === "tool-group") {
		return [...rows.slice(0, -1), { ...last, tools: [...last.tools, tool] }]
	}
	return [...rows, { kind: "tool-group", id: row.id, tools: [tool], expanded }]
}

type ToolTally = { singular: string; plural: string; count: number }

/** "Read 3 files, searched for 2 patterns, ran 1 command" */
export function toolGroupHeading(tools: GroupedTool[]): string {
	const tallies = new Map<string, ToolTally>()
	const add = (key: string, singular: string, pluralForm: string, count = 1) => {
		const tally = tallies.get(key) ?? { singular, plural: pluralForm, count: 0 }
		tally.count += count
		tallies.set(key, tally)
	}
	for (const tool of tools) {
		switch (tool.name) {
			case "read_file": {
				const files = /across (\d+) files?$/.exec(tool.summary)
				add("read", "read 1 file", "read # files", files ? Number(files[1]) : 1)
				break
			}
			case "search_files":
			case "codebase_search":
				add("search", "searched for 1 pattern", "searched for # patterns")
				break
			case "list_files":
			case "list_code_definition_names":
				add("list", "listed 1 directory", "listed # directories")
				break
			case "Bash":
			case "execute_command":
				add("run", "ran 1 command", "ran # commands")
				break
			case "web_search":
				add("web", "searched the web once", "searched the web # times")
				break
			case "web_fetch":
				add("fetch", "fetched 1 page", "fetched # pages")
				break
			default:
				add(tool.name, `used ${formatToolName(tool.name)} once`, `used ${formatToolName(tool.name)} # times`)
		}
	}
	const heading = [...tallies.values()]
		.map((tally) => (tally.count === 1 ? tally.singular : tally.plural.replace("#", String(tally.count))))
		.join(", ")
	return heading.charAt(0).toUpperCase() + heading.slice(1)
}

const TOOL_DISPLAY_NAMES: Record<string, string> = {
	update_todo_list: "Update Tasks",
	lsp: "LSP",
}

/** "read_file" -> "Read File", with overrides for names that don't title-case cleanly. */
export function formatToolName(name: string): string {
	return (
		TOOL_DISPLAY_NAMES[name] ??
		name
			.split("_")
			.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
			.join(" ")
	)
}

const MAX_DIFF_LINES = 60
const ADDED_BG = COLORS.diffAddedBackground
const REMOVED_BG = COLORS.diffRemovedBackground

type DiffRow =
	| { kind: "file"; text: string }
	| { kind: "gap" }
	| { kind: "line"; type: "add" | "del" | "ctx"; num: number; text: string }

/** Parse a unified diff (optionally with bare file-path header lines) into rows. */
function parseDiff(diff: string): { rows: DiffRow[]; added: number; removed: number } {
	const rows: DiffRow[] = []
	let added = 0
	let removed = 0
	let oldLine = 0
	let newLine = 0
	let seenHunk = false

	for (const line of diff.split("\n")) {
		const hunk = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(line)
		if (hunk) {
			if (seenHunk) rows.push({ kind: "gap" })
			oldLine = Number(hunk[1])
			newLine = Number(hunk[2])
			seenHunk = true
		} else if (line.startsWith("+")) {
			rows.push({ kind: "line", type: "add", num: newLine++, text: line.slice(1) })
			added++
		} else if (line.startsWith("-")) {
			rows.push({ kind: "line", type: "del", num: oldLine++, text: line.slice(1) })
			removed++
		} else if (line.startsWith(" ")) {
			rows.push({ kind: "line", type: "ctx", num: newLine++, text: line.slice(1) })
			oldLine++
		} else if (line.trim()) {
			// bare line = file path header (multi-file diffs)
			rows.push({ kind: "file", text: line })
			seenHunk = false
		}
	}
	return { rows, added, removed }
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`
}

/** Claude Code-style diff: stats header, line-number gutter, red/green line backgrounds. */
interface DiffViewProps {
	diff: string
	/** Limit the number of parsed diff rows shown. */
	maxLines?: number
	/** Keep live approval rows to one terminal line instead of wrapping code. */
	maxWidth?: number
}

function oneLine(text: string): string {
	return text.replace(/\s*\n\s*/g, " ")
}

function truncateLine(text: string, maxWidth: number | undefined): string {
	if (!maxWidth || text.length <= maxWidth) return text
	if (maxWidth <= 1) return "…".slice(0, maxWidth)
	return text.slice(0, maxWidth - 1) + "…"
}

/** Number of terminal rows used by DiffView when its lines do not wrap. */
export function diffViewHeight(diff: string, maxLines = MAX_DIFF_LINES): number {
	const { rows } = parseDiff(diff)
	return 1 + Math.min(rows.length, maxLines) + (rows.length > maxLines ? 1 : 0)
}

export function DiffView({ diff, maxLines = MAX_DIFF_LINES, maxWidth }: DiffViewProps) {
	const { rows, added, removed } = parseDiff(diff)
	const visible = rows.slice(0, maxLines)
	const numWidth = Math.max(
		3,
		...visible.map((r) => (r.kind === "line" ? String(r.num).length : 0)),
	)

	return (
		<Box flexDirection="column">
			<Text>
				<Text color={COLORS.dim}>└ </Text>
				Added {plural(added, "line")}, removed {plural(removed, "line")}
			</Text>
			{visible.map((row, i) => {
				if (row.kind === "file") {
					return (
						<Text key={i} bold color={COLORS.dim}>
							{truncateLine(row.text, maxWidth)}
						</Text>
					)
				}
				if (row.kind === "gap") {
					return (
						<Text key={i} color={COLORS.dim}>
							{" ".repeat(numWidth)} ⋯
						</Text>
					)
				}
				const num = String(row.num).padStart(numWidth)
				const prefixWidth = numWidth + 3
				const lineText = truncateLine(
					row.text,
					maxWidth === undefined ? undefined : Math.max(1, maxWidth - prefixWidth),
				)
				if (row.type === "add") {
					return (
						<Text key={i} backgroundColor={ADDED_BG} color={COLORS.success}>
							{num} + {lineText}
						</Text>
					)
				}
				if (row.type === "del") {
					return (
						<Text key={i} backgroundColor={REMOVED_BG} color={COLORS.error}>
							{num} - {lineText}
						</Text>
					)
				}
				return (
					<Text key={i}>
						<Text color={COLORS.dim}>{num}</Text>
						{"   "}
						{lineText}
					</Text>
				)
			})}
			{rows.length > maxLines && <Text color={COLORS.dim}>… {rows.length - maxLines} more lines</Text>}
		</Box>
	)
}

/**
 * Build the user block: `❯` sits in the same column as the assistant's `●`,
 * and wrapped or continuation lines hang under the text, not the marker.
 */
export function formatUserBlock(text: string, width: number, attachments: AttachmentSummary[] = []): string {
	const lineWidth = Math.max(3, width)
	const normalizedText = (text || "").replace(/\t/g, "  ")
	const textLines = (normalizedText || (attachments.length > 0 ? "Attached files" : "")).split("\n")
	const attachmentLines = attachments.map(
		(attachment) =>
			`📎 ${attachment.name}${attachment.kind === "image" ? " · image" : ""}${attachment.truncated ? " · truncated" : ""}`,
	)
	const output: string[] = [""]
	for (const [index, line] of [...textLines, ...attachmentLines].entries()) {
		const marker = index === 0 ? "❯ " : "  "
		if (line.length === 0) {
			output.push(marker.trimEnd())
			continue
		}
		for (let offset = 0; offset < line.length; offset += lineWidth - 2) {
			output.push((offset === 0 ? marker : "  ") + line.slice(offset, offset + lineWidth - 2))
		}
	}
	output.push("")
	return output.join("\n")
}

/**
 * Completed transcript rows are immutable. Keeping their rendered React tree
 * around avoids re-running markdown and diff parsing when only the viewport
 * offset changes.
 */
export const RowView = React.memo(function RowView({ row, width }: { row: Row; width: number }) {
	switch (row.kind) {
		case "header":
			return <Header cwd={row.cwd} modelName={row.modelName} />
		case "user":
			return (
				<Box marginTop={1} flexShrink={0}>
					<Text color={COLORS.user}>
						{formatUserBlock(row.text, width, row.attachments)}
					</Text>
				</Box>
			)
		case "assistant":
			// Sessions saved before blank content was filtered can still hold these.
			if (!row.text.trim()) return null
			return (
				<Box marginTop={1} flexDirection="column" flexShrink={0}>
					<Text>
						<Text color={COLORS.primary}>● </Text>
						{renderMarkdown(row.text.trimEnd(), Math.max(20, width - 2))}
					</Text>
				</Box>
			)
		case "tool":
			return (
				<Box flexDirection="column" marginTop={1} flexShrink={0}>
					<Text>
						<Text color={row.isError ? COLORS.error : COLORS.success}>
							{row.isError ? "✗" : "✓"}{" "}
						</Text>
						<Text bold>{formatToolName(row.name)}</Text>
						<Text color={COLORS.dim}> {row.summary}</Text>
					</Text>
					{row.diff ? (
						<Box paddingLeft={2} flexShrink={0}>
							<DiffView diff={row.diff} />
						</Box>
					) : (
						row.resultPreview && (
							<Box paddingLeft={2} flexShrink={0}>
								<Text color={COLORS.dim}>{row.resultPreview}</Text>
							</Box>
						)
					)}
				</Box>
			)
		case "tool-group": {
			// One line per entry so the height estimate stays exact; the ⎿ line
			// swaps to the latest call while collapsed.
			const lineWidth = Math.max(1, width - 4)
			const latest = row.tools[row.tools.length - 1]
			return (
				<Box flexDirection="column" marginTop={1} flexShrink={0}>
					<Text>
						<Text color={COLORS.success}>● </Text>
						<Text bold>{toolGroupHeading(row.tools)}</Text>
						{!row.expanded && <Text color={COLORS.dim}> (ctrl+o to expand)</Text>}
					</Text>
					{row.expanded
						? row.tools.map((tool, i) => (
								<Text key={i} color={COLORS.dim}>
									{truncateLine(`  ⎿ ${formatToolName(tool.name)} ${oneLine(tool.summary)}`, lineWidth + 4)}
								</Text>
							))
						: latest && (
								<Text color={COLORS.dim}>{truncateLine(`  ⎿ ${oneLine(latest.summary)}`, lineWidth + 4)}</Text>
							)}
				</Box>
			)
		}
		case "info":
			return (
				<Box marginTop={1} flexShrink={0}>
					<Text color={COLORS.dim}>{row.text}</Text>
				</Box>
			)
		case "error":
			return (
				<Box marginTop={1} flexShrink={0}>
					<Text color={COLORS.error}>✗ {row.text}</Text>
				</Box>
			)
		case "completion":
			return (
				<Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={COLORS.success} paddingX={1} flexShrink={0}>
					<Text color={COLORS.success} bold>
						✔ Task completed
					</Text>
					<Text>{renderMarkdown(row.text.trimEnd(), Math.max(20, width - 4))}</Text>
				</Box>
			)
	}
})
