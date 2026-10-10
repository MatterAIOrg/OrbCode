import React from "react"
import stringWidth from "string-width"

import { COLORS } from "../branding.js"
import { Text } from "./primitives.js"

/** Inline markdown: code spans, bold, italics and links. */
const INLINE_MARKDOWN = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|(?<![\w*])\*[^*\n]+\*(?![\w*])|\[[^\]]+\]\([^)]+\))/g

/** A table separator row holds nothing but pipes, dashes and alignment colons. */
const DELIMITER_ROW = /^[\s|:-]+$/

/** Placeholder that keeps an escaped pipe inside its cell while splitting. */
const ESCAPED_PIPE = "\u0000"

/** Every column costs a left border and a padding space either side of its cell, and
 * the grid closes with one right border: widths `w` span `sum(w) + 3 * columns + 1`. */
const CHROME_PER_COLUMN = 3
const CHROME_TOTAL = 1

const GRAPHEMES = new Intl.Segmenter()

type BlockKind = "text" | "fenceOpen" | "code" | "fenceClose" | "table"
type Alignment = "left" | "center" | "right"
type EdgeKind = "top" | "mid" | "content" | "bottom"

interface Block {
	kind: BlockKind
	lines: string[]
}

/** One terminal row of a table grid. */
interface GridLine {
	edge: EdgeKind
	/** Cell text padded to its column; empty on border lines. */
	cells: string[]
	bold: boolean
}

interface TableLayout {
	widths: number[]
	lines: GridLine[]
}

function isFence(line: string): boolean {
	return /^\s*```/.test(line)
}

function isTableLine(line: string): boolean {
	return line.trim() !== "" && line.includes("|")
}

function isDelimiterRow(line: string): boolean {
	const trimmed = line.trim()
	return trimmed !== "" && DELIMITER_ROW.test(trimmed) && trimmed.includes("-")
}

function splitBlocks(lines: string[]): Block[] {
	const blocks: Block[] = []
	let inCode = false
	let pending: string[] = []

	// A run of pipe rows becomes a table at the row above its separator row. Rows before
	// that, or a run whose separator has not arrived yet while streaming, stay plain text.
	const flushTable = () => {
		const start = pending.findIndex((_, index) => index + 1 < pending.length && isDelimiterRow(pending[index + 1]))
		for (const line of start < 0 ? pending : pending.slice(0, start)) blocks.push({ kind: "text", lines: [line] })
		if (start >= 0) blocks.push({ kind: "table", lines: pending.slice(start) })
		pending = []
	}

	for (const line of lines) {
		if (isFence(line)) {
			flushTable()
			blocks.push({ kind: inCode ? "fenceClose" : "fenceOpen", lines: [line] })
			inCode = !inCode
			continue
		}
		if (inCode) {
			blocks.push({ kind: "code", lines: [line] })
			continue
		}
		if (isTableLine(line)) {
			pending.push(line)
			continue
		}
		flushTable()
		blocks.push({ kind: "text", lines: [line] })
	}
	flushTable()
	return blocks
}

/** Split a row into trimmed cells. Escaped pipes stay inside their cell. */
function splitCells(line: string): string[] {
	const cells = line.trim().replaceAll("\\|", ESCAPED_PIPE).split("|")
	if (cells.length > 1) {
		if (cells[0] === "") cells.shift()
		if (cells[cells.length - 1] === "") cells.pop()
	}
	return cells.map((cell) => cell.replaceAll(ESCAPED_PIPE, "|").trim())
}

/** Cell text as it will appear: inline markers render away, links keep their URL. */
function cellText(cell: string): string {
	return cell.replace(INLINE_MARKDOWN, (token) => {
		const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
		if (link) return `${link[1]} ${link[2]}`
		if (token.startsWith("**") || token.startsWith("__")) return token.slice(2, -2)
		return token.slice(1, -1)
	})
}

function alignmentOf(delimiterCell: string): Alignment {
	const colonStart = delimiterCell.length > 1 && delimiterCell.startsWith(":")
	const colonEnd = delimiterCell.length > 1 && delimiterCell.endsWith(":")
	if (colonStart && colonEnd) return "center"
	if (colonEnd) return "right"
	return "left"
}

/**
 * Natural column widths, shrunk only when the grid would overflow `maxWidth`: columns
 * narrower than an even share keep their width, the wider ones split what is left.
 */
function fitWidths(widths: number[], maxWidth: number): number[] {
	const budget = Math.max(widths.length, maxWidth - (CHROME_PER_COLUMN * widths.length + CHROME_TOTAL))
	if (widths.reduce((sum, width) => sum + width, 0) <= budget) return widths

	const fitted = [...widths]
	const open = widths.map((_, index) => index).sort((a, b) => widths[a] - widths[b])
	let remaining = budget
	while (open.length > 0 && widths[open[0]] <= Math.floor(remaining / open.length)) {
		remaining -= widths[open[0]]
		open.shift()
	}
	open.forEach((index, rank) => {
		const extra = rank >= open.length - (remaining % open.length) ? 1 : 0
		fitted[index] = Math.max(1, Math.floor(remaining / open.length) + extra)
	})
	return fitted
}

/** Word-wrap a cell to its column, breaking words that are wider than the column. */
function wrapCell(text: string, width: number): string[] {
	const lines: string[] = []
	let line = ""
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const candidate = line ? `${line} ${word}` : word
		if (stringWidth(candidate) <= width) {
			line = candidate
			continue
		}
		if (line) lines.push(line)
		line = ""
		for (const { segment } of GRAPHEMES.segment(word)) {
			if (line && stringWidth(line + segment) > width) {
				lines.push(line)
				line = ""
			}
			line += segment
		}
	}
	lines.push(line)
	return lines
}

/** A cell padded to its column, aligned as the separator row asks. */
function padCell(text: string, width: number, align: Alignment): string {
	const padding = Math.max(0, width - stringWidth(text))
	if (align === "center") {
		const left = Math.floor(padding / 2)
		return " ".repeat(left) + text + " ".repeat(padding - left)
	}
	if (align === "right") return " ".repeat(padding) + text
	return text + " ".repeat(padding)
}

/**
 * Lay a table block out as grid lines: a bold header, then the body. Cells wrap inside
 * their column, and once any body row wraps every body row gets a rule beneath it.
 */
function layoutTable(lines: string[], maxWidth: number): TableLayout {
	const rows = lines.map(splitCells)
	const columns = Math.max(1, ...rows.map((row) => row.length))
	const aligns = Array.from({ length: columns }, (_, column) => alignmentOf(rows[1][column] ?? ""))
	const [header, , ...body] = rows.map((row) => Array.from({ length: columns }, (_, column) => cellText(row[column] ?? "")))
	const widths = fitWidths(
		Array.from({ length: columns }, (_, column) =>
			Math.max(1, ...[header, ...body].map((row) => stringWidth(row[column]))),
		),
		maxWidth,
	)

	const contentLines = (row: string[], bold: boolean): GridLine[] => {
		const wrapped = row.map((cell, column) => wrapCell(cell, widths[column]))
		return Array.from({ length: Math.max(...wrapped.map((cell) => cell.length)) }, (_, line) => ({
			edge: "content",
			cells: wrapped.map((cell, column) => padCell(cell[line] ?? "", widths[column], aligns[column])),
			bold,
		}))
	}
	const border = (edge: EdgeKind): GridLine => ({ edge, cells: [], bold: false })
	const bodyLines = body.map((row) => contentLines(row, false))
	const ruled = bodyLines.some((row) => row.length > 1)

	return {
		widths,
		lines: [
			border("top"),
			...contentLines(header, true),
			...(body.length > 0 ? [border("mid")] : []),
			...bodyLines.flatMap((row, index) => (ruled && index > 0 ? [border("mid"), ...row] : row)),
			border("bottom"),
		],
	}
}

/** Border characters of a grid row: `columns + 1` of them, corners on the edges. */
function edgeChars(kind: EdgeKind, columns: number): string[] {
	const [first, middle, last] =
		kind === "top"
			? ["╭", "┬", "╮"]
			: kind === "mid"
				? ["├", "┼", "┤"]
				: kind === "bottom"
					? ["╰", "┴", "╯"]
					: ["│", "│", "│"]
	return Array.from({ length: columns + 1 }, (_, column) =>
		column === 0 ? first : column === columns ? last : middle,
	)
}

/** One grid line: dim borders around dashes on border lines, padded cells on content lines. */
function gridRow(line: GridLine, widths: number[], key: string): React.ReactNode[] {
	return edgeChars(line.edge, widths.length).flatMap((edge, column) => {
		const segments = [
			<Text key={`${key}-e${column}`} color={COLORS.dim}>
				{edge}
			</Text>,
		]
		if (column < widths.length)
			segments.push(
				line.cells.length === 0 ? (
					<Text key={`${key}-c${column}`} color={COLORS.dim}>
						{"─".repeat(widths[column] + 2)}
					</Text>
				) : (
					<Text key={`${key}-c${column}`} bold={line.bold}>
						{` ${line.cells[column]} `}
					</Text>
				),
			)
		return segments
	})
}

/** A markdown table drawn as a bordered grid no wider than `maxWidth`. */
function tableRows(lines: string[], blockIndex: number, maxWidth: number): React.ReactNode[] {
	const { widths, lines: grid } = layoutTable(lines, maxWidth)
	return grid.map((line, index) => gridRow(line, widths, `t${blockIndex}-${index}`))
}

/** A plain markdown line: heading, list item, quote, rule, code fence or paragraph. */
function textRows(block: Block, blockIndex: number, maxWidth: number): React.ReactNode[] {
	const line = block.lines[0]
	const key = `b${blockIndex}`

	if (block.kind === "fenceOpen") {
		const language = /^\s*```(.*)$/.exec(line)?.[1].trim() ?? ""
		return [<Text key={key} color={COLORS.dim}>{language ? `╭─ ${language}` : "╭─"}</Text>]
	}
	if (block.kind === "code")
		return [
			<React.Fragment key={key}>
				<Text color={COLORS.dim}>│ </Text>
				<Text color={COLORS.accent}>{line}</Text>
			</React.Fragment>,
		]
	if (block.kind === "fenceClose") return [<Text key={key} color={COLORS.dim}>╰─</Text>]

	const header = /^(#{1,6})\s+(.*)$/.exec(line)
	const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line)
	const ordered = /^(\s*)(\d+)\.\s+(.*)$/.exec(line)
	const quote = /^>\s?(.*)$/.exec(line)

	if (header) return [<Text key={key} bold underline>{renderInline(header[2], `h-${blockIndex}`)}</Text>]
	if (bullet)
		return [<React.Fragment key={key}>{bullet[1]}• {renderInline(bullet[2], `b-${blockIndex}`)}</React.Fragment>]
	if (ordered)
		return [
			<React.Fragment key={key}>
				{ordered[1]}
				{ordered[2]}. {renderInline(ordered[3], `o-${blockIndex}`)}
			</React.Fragment>,
		]
	if (quote) return [<Text key={key} color={COLORS.dim}>│ {renderInline(quote[1], `q-${blockIndex}`)}</Text>]
	if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line))
		return [<Text key={key} color={COLORS.dim}>{"─".repeat(Math.max(1, maxWidth))}</Text>]
	return [<React.Fragment key={key}>{renderInline(line, `p-${blockIndex}`)}</React.Fragment>]
}

/**
 * Markdown rendered as styled text. Every block — heading, list, quote, code block,
 * table — contributes one or more terminal rows, and consecutive rows are separated
 * by newlines so the surrounding text node keeps them on separate lines.
 */
export function renderMarkdown(markdown: string, maxWidth = 80): React.ReactNode {
	const rows: React.ReactNode[] = []
	let blockIndex = 0

	for (const block of splitBlocks(markdown.split("\n"))) {
		const blockRows =
			block.kind === "table"
				? tableRows(block.lines, blockIndex, maxWidth)
				: textRows(block, blockIndex, maxWidth)
		for (const row of blockRows) {
			if (rows.length > 0) rows.push("\n")
			rows.push(row)
		}
		blockIndex++
	}

	return <>{rows}</>
}

/**
 * Terminal rows `renderMarkdown(markdown, maxWidth)` occupies: a table's grid lines,
 * and every other line wrapped at `wrapWidth`, the first after `prefix` columns.
 */
export function markdownRowCount(markdown: string, maxWidth: number, wrapWidth: number, prefix = 0): number {
	const available = Math.max(1, wrapWidth)
	return splitBlocks(markdown.split("\n")).reduce((sum, block, index) => {
		if (block.kind === "table") return sum + layoutTable(block.lines, maxWidth).lines.length
		const length = block.lines[0].length + (index === 0 ? prefix : 0)
		return sum + Math.max(1, Math.ceil(Math.max(1, length) / available))
	}, 0)
}

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
	const nodes: React.ReactNode[] = []
	let cursor = 0
	let match: RegExpExecArray | null
	INLINE_MARKDOWN.lastIndex = 0
	let index = 0

	while ((match = INLINE_MARKDOWN.exec(text))) {
		if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
		const token = match[0]
		const key = `${keyPrefix}-${index++}`
		if (token.startsWith("`")) {
			nodes.push(<Text key={key} color={COLORS.accent}>{token.slice(1, -1)}</Text>)
		} else if (token.startsWith("**") || token.startsWith("__")) {
			nodes.push(<Text key={key} bold>{token.slice(2, -2)}</Text>)
		} else if (token.startsWith("*")) {
			nodes.push(<Text key={key} italic>{token.slice(1, -1)}</Text>)
		} else {
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
			if (link) {
				nodes.push(
					<React.Fragment key={key}>
						{link[1]} <Text key={`${key}-url`} color={COLORS.dim} underline>{link[2]}</Text>
					</React.Fragment>,
				)
			}
		}
		cursor = match.index + token.length
	}

	if (cursor < text.length) nodes.push(text.slice(cursor))
	return nodes
}
