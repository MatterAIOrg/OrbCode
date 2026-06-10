import React, { useEffect, useMemo, useState } from "react"
import { Box, Text, useInput } from "ink"
import chalk from "chalk"

import { COLORS } from "../../branding.js"
import { walkFiles } from "../../tools/executors/listFiles.js"
import { appendPromptHistory, loadPromptHistory } from "../../config/promptHistory.js"

export interface SlashCommand {
	name: string
	description: string
}

interface InputBoxProps {
	active: boolean
	slashCommands: SlashCommand[]
	onSubmit: (value: string) => void
}

const MAX_FILE_MATCHES = 8

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

export function InputBox({ active, slashCommands, onSubmit }: InputBoxProps) {
	const [value, setValue] = useState("")
	const [cursor, setCursor] = useState(0)
	// Terminal-style prompt history: persisted across sessions in ~/.orbcode.
	const [history, setHistory] = useState<string[]>(() => loadPromptHistory())
	const [historyIndex, setHistoryIndex] = useState(-1)
	const [fileIndex, setFileIndex] = useState(0)
	const [slashIndex, setSlashIndex] = useState(0)
	const [dismissedValue, setDismissedValue] = useState<string | null>(null)

	// Workspace file list for @-references, computed once per session.
	const files = useMemo(
		() => walkFiles(process.cwd(), true, 3000).filter((f) => !f.endsWith("/")),
		[],
	)

	const showSlashMenu = active && value.startsWith("/") && !value.includes(" ")
	const slashMatches = showSlashMenu
		? slashCommands.filter((c) => c.name.startsWith(value)).slice(0, 8)
		: []

	const atToken = active ? findAtToken(value, cursor) : null
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
				if (key.escape) {
					setDismissedValue(value)
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
				// Multi-char chunks (paste) can carry an embedded trailing newline,
				// which should submit like pressing Enter.
				const endsWithNewline = /[\r\n]$/.test(input)
				const clean = input.replace(/[\r\n]+$/, "").replace(/\r/g, "\n")
				const next = value.slice(0, cursor) + clean + value.slice(cursor)
				if (endsWithNewline) {
					submit(next)
					return
				}
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

	return (
		<Box flexDirection="column">
			<Box
				borderStyle="round"
				borderColor={active ? COLORS.primary : "gray"}
				borderLeft={false}
				borderRight={false}
				paddingX={1}
			>
				<Text color={COLORS.user} bold>
					{"❯ "}
				</Text>
				{active ? <Text>{display}</Text> : <Text dimColor>{value || "waiting…"}</Text>}
			</Box>
			{slashMatches.length > 0 && (
				<Box flexDirection="column" paddingLeft={2}>
					{slashMatches.map((c, i) => (
						<Text key={c.name}>
							<Text color={i === slashIndex ? COLORS.accent : undefined}>
								{i === slashIndex ? "❯ " : "  "}
								{c.name}
							</Text>
							<Text dimColor> — {c.description}</Text>
						</Text>
					))}
					<Text dimColor>↑/↓ select · enter run · tab complete</Text>
				</Box>
			)}
			{fileMatches.length > 0 && (
				<Box flexDirection="column" paddingLeft={2}>
					{fileMatches.map((file, i) => (
						<Text key={file} color={i === fileIndex ? COLORS.accent : undefined}>
							{i === fileIndex ? "❯ " : "  "}
							{file}
						</Text>
					))}
					<Text dimColor>↑/↓ select · enter/tab insert · esc dismiss</Text>
				</Box>
			)}
		</Box>
	)
}
