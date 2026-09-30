import React, { useState } from "react"
import * as os from "node:os"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"
import type { SessionData } from "../../core/sessions.js"
import { PopoverBox } from "./PopoverBox.js"

const VISIBLE_ROWS = 8

interface SessionPickerProps {
	/** sessions from the current directory */
	sessions: SessionData[]
	/** sessions from every directory; when given, Tab switches between the two lists */
	allSessions?: SessionData[]
	/** start on the all-directories list (e.g. nothing to resume here) */
	initialShowAll?: boolean
	/** current directory; sessions elsewhere show their directory */
	cwd?: string
	onSelect: (session: SessionData) => void
	onCancel: () => void
	title?: string
}

/** Shorten a directory for display: `~` for home, and at most the last 3 segments. */
function shortDir(dir: string): string {
	const home = os.homedir()
	const withHome = dir === home || dir.startsWith(home + "/") ? "~" + dir.slice(home.length) : dir
	const parts = withHome.split("/")
	return parts.length > 4 ? "…/" + parts.slice(-3).join("/") : withHome
}

function relativeTime(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime()
	const minutes = Math.round(ms / 60_000)
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes}m ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours}h ago`
	const days = Math.round(hours / 24)
	return `${days}d ago`
}

export function SessionPicker({
	sessions: localSessions,
	allSessions,
	initialShowAll = false,
	cwd,
	onSelect,
	onCancel,
	title = "Resume a previous session",
}: SessionPickerProps) {
	const [selected, setSelected] = useState(0)
	const [showAll, setShowAll] = useState(initialShowAll && allSessions !== undefined)
	const sessions = showAll && allSessions ? allSessions : localSessions

	useInput((input, key) => {
		if (key.tab && allSessions) {
			setShowAll((value) => !value)
			setSelected(0)
			return
		}
		if (sessions.length === 0) {
			if (key.escape) onCancel()
			return
		}
		if (key.upArrow) {
			setSelected((s) => (s - 1 + sessions.length) % sessions.length)
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((s) => (s + 1) % sessions.length)
			return
		}
		if (key.return) {
			onSelect(sessions[selected])
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
		if (/^[1-9]$/.test(input)) {
			const index = Number(input) - 1
			if (index < sessions.length) onSelect(sessions[index])
		}
	})

	const windowStart = Math.max(0, Math.min(selected - VISIBLE_ROWS + 1, sessions.length - VISIBLE_ROWS))
	const visible = sessions.slice(windowStart, windowStart + VISIBLE_ROWS)

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				{title}
				{allSessions && <Text color={COLORS.dim}> · {showAll ? "all directories" : "this directory"}</Text>}
			</Text>
			{sessions.length === 0 && (
				<Text color={COLORS.dim}>  No sessions {showAll ? "yet" : "in this directory"}.</Text>
			)}
			{windowStart > 0 && <Text color={COLORS.dim}>  ↑ {windowStart} more</Text>}
			{visible.map((session, i) => {
				const index = windowStart + i
				const isSelected = index === selected
				const userTurns = session.messages.filter((m) => m.role === "user").length
				return (
					<Text key={session.id} color={isSelected ? COLORS.accent : undefined}>
						{isSelected ? "❯ " : "  "}
						{index + 1}. {session.title || "(untitled)"}
						<Text color={COLORS.dim}>
							{" "}
							· {relativeTime(session.updatedAt)} · {userTurns} message{userTurns === 1 ? "" : "s"}
							{showAll && session.cwd !== cwd ? ` · ${shortDir(session.cwd)}` : ""}
						</Text>
					</Text>
				)
			})}
			{windowStart + VISIBLE_ROWS < sessions.length && (
				<Text color={COLORS.dim}>  ↓ {sessions.length - windowStart - VISIBLE_ROWS} more</Text>
			)}
			<Text color={COLORS.dim}>
				↑/↓ select · enter resume{allSessions ? ` · tab ${showAll ? "this directory" : "all directories"}` : ""} · esc cancel
			</Text>
		</PopoverBox>
	)
}
