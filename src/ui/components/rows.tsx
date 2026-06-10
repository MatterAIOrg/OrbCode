import React from "react"
import { Box, Text } from "ink"

import { COLORS } from "../../branding.js"
import { renderMarkdown } from "../markdown.js"
import { Header } from "./Header.js"

export type Row =
	| { kind: "header"; id: string; cwd: string; modelName: string }
	| { kind: "user"; id: string; text: string }
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
const ADDED_BG = "#1C4428"
const REMOVED_BG = "#5C1A1A"

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
export function DiffView({ diff }: { diff: string }) {
	const { rows, added, removed } = parseDiff(diff)
	const visible = rows.slice(0, MAX_DIFF_LINES)
	const numWidth = Math.max(
		3,
		...visible.map((r) => (r.kind === "line" ? String(r.num).length : 0)),
	)

	return (
		<Box flexDirection="column">
			<Text>
				<Text dimColor>└ </Text>
				Added {plural(added, "line")}, removed {plural(removed, "line")}
			</Text>
			{visible.map((row, i) => {
				if (row.kind === "file") {
					return (
						<Text key={i} bold dimColor>
							{row.text}
						</Text>
					)
				}
				if (row.kind === "gap") {
					return (
						<Text key={i} dimColor>
							{" ".repeat(numWidth)} ⋯
						</Text>
					)
				}
				const num = String(row.num).padStart(numWidth)
				if (row.type === "add") {
					return (
						<Text key={i} backgroundColor={ADDED_BG}>
							{num} + {row.text}
						</Text>
					)
				}
				if (row.type === "del") {
					return (
						<Text key={i} backgroundColor={REMOVED_BG}>
							{num} - {row.text}
						</Text>
					)
				}
				return (
					<Text key={i}>
						<Text dimColor>{num}</Text>
						{"   "}
						{row.text}
					</Text>
				)
			})}
			{rows.length > MAX_DIFF_LINES && <Text dimColor>… {rows.length - MAX_DIFF_LINES} more lines</Text>}
		</Box>
	)
}

export function formatDuration(durationMs: number): string {
	const seconds = durationMs / 1000
	return seconds >= 10 ? `${Math.round(seconds)}s` : `${seconds.toFixed(1)}s`
}

export function RowView({ row }: { row: Row }) {
	switch (row.kind) {
		case "header":
			return <Header cwd={row.cwd} modelName={row.modelName} />
		case "user":
			return (
				<Box marginTop={1}>
					<Text color={COLORS.user} bold>
						{"❯ "}
					</Text>
					<Text color={COLORS.user}>{row.text}</Text>
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
						{!row.expanded && <Text dimColor> (ctrl+o to show thinking)</Text>}
					</Text>
					{row.expanded && (
						<Box paddingLeft={2}>
							<Text dimColor italic>
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
						<Text dimColor> {row.summary}</Text>
					</Text>
					{row.diff ? (
						<Box paddingLeft={2}>
							<DiffView diff={row.diff} />
						</Box>
					) : (
						row.resultPreview && (
							<Box paddingLeft={2}>
								<Text dimColor>{row.resultPreview}</Text>
							</Box>
						)
					)}
				</Box>
			)
		case "info":
			return (
				<Box marginTop={1}>
					<Text dimColor>{row.text}</Text>
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
}
