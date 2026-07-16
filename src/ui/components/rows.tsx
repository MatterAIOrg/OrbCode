import React from "react"
import { Box, Text } from "../primitives.js"

import type { AttachmentSummary } from "../../attachments.js"
import { COLORS } from "../../branding.js"
import { renderMarkdown } from "../markdown.js"
import { Header } from "./Header.js"

export type Row =
	| { kind: "header"; id: string; cwd: string; modelName: string }
	| { kind: "user"; id: string; text: string; attachments?: AttachmentSummary[] }
	| { kind: "assistant"; id: string; text: string }
	| { kind: "reasoning"; id: string; text: string; durationMs: number; expanded: boolean }
	| {
		kind: "tool"
		id: string
		name: string
		summary: string
		resultPreview: string
		isError: boolean
		diff?: string
	}
	| { kind: "info"; id: string; text: string }
	| { kind: "error"; id: string; text: string }
	| { kind: "completion"; id: string; text: string }

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

export function formatDuration(durationMs: number): string {
	const seconds = durationMs / 1000
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`
}

/** Build a padded user block exactly as wide as the transcript. */
export function formatUserBlock(text: string, width: number, attachments: AttachmentSummary[] = []): string {
	const lineWidth = Math.max(1, width)
	const paddingX = Math.min(2, Math.floor((lineWidth - 1) / 2))
	const contentWidth = Math.max(1, lineWidth - paddingX * 2)
	const attachmentLines = attachments.map(
		(attachment) =>
			`  📎 ${attachment.name}${attachment.kind === "image" ? " · image" : ""}${attachment.truncated ? " · truncated" : ""}`,
	)
	const sourceLines = [`❯ ${text || (attachments.length > 0 ? "Attached files" : "")}`, ...attachmentLines].flatMap(
		(line) => line.split("\n"),
	)
	const blank = " ".repeat(lineWidth)
	const output: string[] = [blank]
	for (const sourceLine of sourceLines) {
		if (sourceLine.length === 0) {
			output.push(blank)
			continue
		}
		for (let offset = 0; offset < sourceLine.length; offset += contentWidth) {
			output.push(
				" ".repeat(paddingX) +
				sourceLine.slice(offset, offset + contentWidth).padEnd(contentWidth) +
				" ".repeat(paddingX),
			)
		}
	}
	output.push(blank)
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
				<Box marginTop={1}>
					<Text color={COLORS.user}>
						{formatUserBlock(row.text, width, row.attachments)}
					</Text>
				</Box>
			)
		case "assistant":
			return (
				<Box marginTop={1} flexDirection="column">
					<Text>
						<Text color={COLORS.primary}>● </Text>
						{renderMarkdown(row.text.trimEnd())}
					</Text>
				</Box>
			)
		case "reasoning":
			return (
				<Box marginTop={1} flexDirection="column">
					<Text color={COLORS.thinking} italic>
						✦ Thought for {formatDuration(row.durationMs)}
						{!row.expanded && <Text color={COLORS.dim}> (ctrl+o to show thinking)</Text>}
					</Text>
					{row.expanded && (
						<Box paddingLeft={2}>
							<Text color={COLORS.dim} italic>
								{row.text.trim()}
							</Text>
						</Box>
					)}
				</Box>
			)
		case "tool":
			return (
				<Box flexDirection="column" marginTop={1}>
					<Text>
						<Text color={row.isError ? COLORS.error : COLORS.success}>
							{row.isError ? "✗" : "✓"}{" "}
						</Text>
						<Text bold>{formatToolName(row.name)}</Text>
						<Text color={COLORS.dim}> {row.summary}</Text>
					</Text>
					{row.diff ? (
						<Box paddingLeft={2}>
							<DiffView diff={row.diff} />
						</Box>
					) : (
						row.resultPreview && (
							<Box paddingLeft={2}>
								<Text color={COLORS.dim}>{row.resultPreview}</Text>
							</Box>
						)
					)}
				</Box>
			)
		case "info":
			return (
				<Box marginTop={1}>
					<Text color={COLORS.dim}>{row.text}</Text>
				</Box>
			)
		case "error":
			return (
				<Box marginTop={1}>
					<Text color={COLORS.error}>✗ {row.text}</Text>
				</Box>
			)
		case "completion":
			return (
				<Box marginTop={1} flexDirection="column" borderStyle="round" borderColor={COLORS.success} paddingX={1}>
					<Text color={COLORS.success} bold>
						✔ Task completed
					</Text>
					<Text>{renderMarkdown(row.text.trimEnd())}</Text>
				</Box>
			)
	}
})
