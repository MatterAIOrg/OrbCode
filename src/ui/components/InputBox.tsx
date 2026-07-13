import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Box, Text, useInput } from "ink"
import chalk from "chalk"

import { COLORS } from "../../branding.js"
import { walkFiles } from "../../tools/executors/listFiles.js"
import { appendPromptHistory, loadPromptHistory } from "../../config/promptHistory.js"
import { isMouseInput } from "../terminal.js"

export interface SlashCommand {
	name: string
	description: string
}

interface InputBoxProps {
	active: boolean
	width: number
	slashCommands: SlashCommand[]
	onSubmit: (value: string) => void
	/** Reports the complete rendered height, including autocomplete popups. */
	onHeightChange?: (height: number) => void
}

const MAX_FILE_MATCHES = 8
const POPUP_PADDING_X = 2

function fitText(text: string, maxWidth: number): string {
	if (text.length <= maxWidth) return text
	if (maxWidth <= 1) return text.slice(0, Math.max(0, maxWidth))
	return text.slice(0, maxWidth - 1) + "…"
}

function PopupEdge({ width, position }: { width: number; position: "top" | "bottom" }) {
	const innerWidth = Math.max(0, width - 2)
	return (
		<Text color={COLORS.popupBg}>
			{position === "top"
				? `▗${"▄".repeat(innerWidth)}▖`
				: `▝${"▀".repeat(innerWidth)}▘`}
		</Text>
	)
}

function PopupRow({
	width,
	contentWidth,
	children,
}: {
	width: number
	contentWidth: number
	children: React.ReactNode
}) {
	const trailing = Math.max(0, width - POPUP_PADDING_X * 2 - contentWidth)
	return (
		<Text backgroundColor={COLORS.popupBg}>
			{" ".repeat(POPUP_PADDING_X)}
			{children}
			{" ".repeat(trailing + POPUP_PADDING_X)}
		</Text>
	)
}

/** Higher is better; -1 means no match. Prefers basename prefix > basename > path > subsequence. */
function fuzzyScore(target: string, query: string): number {
	if (!query) return 1
	const t = target.toLowerCase()
	const q = query.toLowerCase()
	const base = (target.split("/").pop() ?? target).toLowerCase()
	if (base.startsWith(q)) return 4000 - target.length
	if (base.includes(q)) return 3000 - target.length
	const idx = t.indexOf(q)
	if (idx !== -1) return 2000 - idx - target.length
	let qi = 0
	for (let i = 0; i < t.length && qi < q.length; i++) {
		if (t[i] === q[qi]) qi++
	}
	if (qi === q.length) return 1000 - target.length
	return -1
}

/** The `@token` being typed at the cursor, if any. */
function findAtToken(value: string, cursor: number): { query: string; start: number } | null {
	const before = value.slice(0, cursor)
	const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
	if (!match) return null
	return { query: match[1], start: cursor - match[1].length - 1 }
}

export function InputBox({ active, width, slashCommands, onSubmit, onHeightChange }: InputBoxProps) {
	const [value, setValue] = useState("")
	const [cursor, setCursor] = useState(0)
	// Terminal-style prompt history: persisted across sessions in ~/.orbcode.
	const [history, setHistory] = useState<string[]>(() => loadPromptHistory())
	const [historyIndex, setHistoryIndex] = useState(-1)
	const [fileIndex, setFileIndex] = useState(0)
	const [slashIndex, setSlashIndex] = useState(0)
	const [dismissedValue, setDismissedValue] = useState<string | null>(null)

	const showSlashMenu = active && value.startsWith("/") && !value.includes(" ")
	const slashMatches = showSlashMenu
		? slashCommands.filter((c) => c.name.startsWith(value)).slice(0, 8)
		: []

	const atToken = active ? findAtToken(value, cursor) : null

	// Workspace file list for @-references, re-scanned each time the popup opens.
	// Files created during the session (by editing or manually) become visible.
	const [files, setFiles] = useState<string[]>([])
	const wasClosed = useRef(true)
	if (atToken && wasClosed.current) {
		wasClosed.current = false
		setFiles(walkFiles(process.cwd(), true, 3000).filter((f) => !f.endsWith("/")))
	} else if (!atToken) {
		wasClosed.current = true
	}

	const fileMatches = useMemo(() => {
		if (!atToken || value === dismissedValue) return []
		return files
			.map((file) => ({ file, score: fuzzyScore(file, atToken.query) }))
			.filter((m) => m.score >= 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, MAX_FILE_MATCHES)
			.map((m) => m.file)
	}, [files, atToken?.query, atToken?.start, value, dismissedValue])

	useEffect(() => {
		setFileIndex(0)
	}, [atToken?.query])

	useEffect(() => {
		setSlashIndex(0)
	}, [value])

	const submit = (text: string) => {
		const trimmed = text.trim()
		if (!trimmed) return
		setHistory((h) => (h[h.length - 1] === trimmed ? h : [...h, trimmed]))
		appendPromptHistory(trimmed)
		setHistoryIndex(-1)
		setValue("")
		setCursor(0)
		onSubmit(trimmed)
	}

	const recallHistory = (index: number) => {
		setHistoryIndex(index)
		const entry = index === -1 ? "" : history[index]
		setValue(entry)
		setCursor(entry.length)
	}

	const insertFile = (file: string) => {
		if (!atToken) return
		const next = `${value.slice(0, atToken.start)}@${file} ${value.slice(cursor)}`
		setValue(next)
		setCursor(atToken.start + file.length + 2)
	}

	useInput(
		(input, key) => {
			if (isMouseInput(input)) return
			if (key.escape && value.length > 0) {
				setValue("")
				setCursor(0)
				setHistoryIndex(-1)
				setFileIndex(0)
				setSlashIndex(0)
				setDismissedValue(null)
				return
			}
			// While actively browsing history, arrows keep navigating history even
			// if a recalled entry opened the slash/file menu.
			if ((key.upArrow || key.downArrow) && historyIndex !== -1) {
				if (key.upArrow) {
					recallHistory(Math.max(0, historyIndex - 1))
				} else {
					const next = historyIndex + 1
					recallHistory(next >= history.length ? -1 : next)
				}
				return
			}
			const fileMenuOpen = fileMatches.length > 0
			if (fileMenuOpen) {
				if (key.upArrow) {
					setFileIndex((i) => (i - 1 + fileMatches.length) % fileMatches.length)
					return
				}
				if (key.downArrow) {
					setFileIndex((i) => (i + 1) % fileMatches.length)
					return
				}
				if (key.return || (key.tab && !key.shift)) {
					insertFile(fileMatches[Math.min(fileIndex, fileMatches.length - 1)])
					return
				}
			}
			if (slashMatches.length > 0) {
				const selected = slashMatches[Math.min(slashIndex, slashMatches.length - 1)]
				if (key.upArrow) {
					setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
					return
				}
				if (key.downArrow) {
					setSlashIndex((i) => (i + 1) % slashMatches.length)
					return
				}
				if (key.return) {
					// A partial command submits the highlighted match (/mod -> /model).
					submit(selected.name)
					return
				}
				if (key.tab && !key.shift) {
					// Tab completes the highlighted match without submitting.
					setValue(selected.name)
					setCursor(selected.name.length)
					return
				}
			}
			if (key.shift && key.return) {
				// Shift+Enter inserts a literal newline without submitting.
				setHistoryIndex(-1)
				const next = value.slice(0, cursor) + "\n" + value.slice(cursor)
				setValue(next)
				setCursor((c) => c + 1)
				return
			}
			if (key.return) {
				submit(value)
				return
			}
			if (key.upArrow) {
				if (history.length === 0) return
				recallHistory(historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1))
				return
			}
			if (key.downArrow) {
				if (historyIndex === -1) return
				const next = historyIndex + 1
				recallHistory(next >= history.length ? -1 : next)
				return
			}
			if (key.leftArrow) {
				setCursor((c) => Math.max(0, c - 1))
				return
			}
			if (key.rightArrow) {
				setCursor((c) => Math.min(value.length, c + 1))
				return
			}
			if (key.backspace || key.delete) {
				if (cursor > 0) {
					setHistoryIndex(-1)
					setValue((v) => v.slice(0, cursor - 1) + v.slice(cursor))
					setCursor((c) => c - 1)
				}
				return
			}
			if (key.ctrl && input === "a") {
				setCursor(0)
				return
			}
			if (key.ctrl && input === "e") {
				setCursor(value.length)
				return
			}
			if (key.ctrl && input === "u") {
				setHistoryIndex(-1)
				setValue("")
				setCursor(0)
				return
			}
			if (key.ctrl || key.meta || key.escape || key.tab) {
				return
			}
			if (input) {
				// Multi-char chunks (paste) are inserted as-is. Newlines inside
				// the chunk are literal newlines, not a submit signal — press
				// Enter when you're ready to send.
				const clean = input.replace(/\r\n?/g, "\n")
				const next = value.slice(0, cursor) + clean + value.slice(cursor)
				setHistoryIndex(-1)
				setValue(next)
				setCursor((c) => c + clean.length)
			}
		},
		{ isActive: active },
	)

	// The cursor block is baked into one string with chalk: nested <Text>
	// siblings around an inverse space make Ink's layout momentarily wrap the
	// cursor to the next line on short values.
	const display =
		value.slice(0, cursor) + chalk.inverse(value[cursor] ?? " ") + value.slice(cursor + 1)
	const plainDisplay = active
		? value.slice(0, cursor) + (value[cursor] ?? " ") + value.slice(cursor + 1)
		: value || "waiting…"
	// Border (2) + wrapped prompt content. The prompt glyph occupies two
	// columns beside the editable text, while border and padding consume four.
	const editableWidth = Math.max(1, width - 6)
	const promptHeight = plainDisplay.split("\n").reduce(
		(sum, line) => sum + Math.max(1, Math.ceil(Math.max(1, line.length) / editableWidth)),
		0,
	)
	const slashPopupHeight = slashMatches.length > 0 ? slashMatches.length + 3 : 0
	const filePopupHeight = fileMatches.length > 0 ? fileMatches.length + 3 : 0
	const renderedHeight = 2 + promptHeight + slashPopupHeight + filePopupHeight

	// Parent viewport calculations must use the real bottom-stack height. A
	// layout effect updates it before Ink paints the next frame, preventing a
	// multiline prompt or popup from covering the live response above it.
	useLayoutEffect(() => {
		onHeightChange?.(renderedHeight)
	}, [onHeightChange, renderedHeight])

	return (
		<Box flexDirection="column">
			{slashMatches.length > 0 && (
				<Box flexDirection="column">
					<PopupEdge width={width} position="top" />
					{slashMatches.map((c, i) => {
						const prefix = i === slashIndex ? "❯ " : "  "
						const descriptionWidth = Math.max(
							0,
							width - POPUP_PADDING_X * 2 - prefix.length - c.name.length - 3,
						)
						const description = fitText(c.description, descriptionWidth)
						const contentWidth = prefix.length + c.name.length + 3 + description.length
						return (
							<PopupRow key={c.name} width={width} contentWidth={contentWidth}>
								<Text color={i === slashIndex ? COLORS.primary : COLORS.accent} bold={i === slashIndex}>
									{prefix}{c.name}
								</Text>
								<Text color={COLORS.dim}> — {description}</Text>
							</PopupRow>
						)
					})}
					{(() => {
						const hint = fitText("↑/↓ select · enter run · tab complete", width - POPUP_PADDING_X * 2)
						return (
							<PopupRow width={width} contentWidth={hint.length}>
								<Text color={COLORS.dim}>{hint}</Text>
							</PopupRow>
						)
					})()}
					<PopupEdge width={width} position="bottom" />
				</Box>
			)}
			{fileMatches.length > 0 && (
				<Box flexDirection="column">
					<PopupEdge width={width} position="top" />
					{fileMatches.map((file, i) => {
						const prefix = i === fileIndex ? "❯ " : "  "
						const displayFile = fitText(file, width - POPUP_PADDING_X * 2 - prefix.length)
						return (
							<PopupRow key={file} width={width} contentWidth={prefix.length + displayFile.length}>
								<Text color={i === fileIndex ? COLORS.primary : COLORS.accent} bold={i === fileIndex}>
									{prefix}{displayFile}
								</Text>
							</PopupRow>
						)
					})}
					{(() => {
						const hint = fitText("↑/↓ select · enter/tab insert · esc dismiss", width - POPUP_PADDING_X * 2)
						return (
							<PopupRow width={width} contentWidth={hint.length}>
								<Text color={COLORS.dim}>{hint}</Text>
							</PopupRow>
						)
					})()}
					<PopupEdge width={width} position="bottom" />
				</Box>
			)}
			<Box
				borderStyle="round"
				borderColor={active ? COLORS.inputBorder : COLORS.inputBorderInactive}
				paddingX={1}
			>
				<Text color={COLORS.user} bold>
					{"❯ "}
				</Text>
				{active ? <Text>{display}</Text> : <Text color={COLORS.dim}>{value || "waiting…"}</Text>}
			</Box>
		</Box>
	)
}
