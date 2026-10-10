import React, { useState } from "react"
import * as os from "node:os"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"
import type { SessionData } from "../../core/sessions.js"
import { PopoverBox } from "./PopoverBox.js"

const VISIBLE_ROWS = 6

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

function plural(count: number, unit: string): string {
	return `${count} ${unit}${count === 1 ? "" : "s"} ago`
}

function relativeTime(iso: string): string {
	const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
	if (seconds < 60) return plural(seconds, "second")
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return plural(minutes, "minute")
	const hours = Math.round(minutes / 60)
	if (hours < 24) return plural(hours, "hour")
	return plural(Math.round(hours / 24), "day")
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
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
			<Box height={1} />
			{sessions.length === 0 && (
				<Text color={COLORS.dim}>  No sessions {showAll ? "yet" : "in this directory"}.</Text>
			)}
			{windowStart > 0 && <Text color={COLORS.dim}>  ↑ {windowStart} more</Text>}
			{visible.map((session, i) => {
				const index = windowStart + i
				const isSelected = index === selected
				const details = [
					relativeTime(session.updatedAt),
					session.gitBranch,
					session.sizeBytes !== undefined ? formatSize(session.sizeBytes) : undefined,
					showAll && session.cwd !== cwd ? shortDir(session.cwd) : undefined,
				].filter(Boolean)
				return (
					<Box key={session.id} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
						<Text color={isSelected ? COLORS.accent : undefined} wrap="truncate">
							{isSelected ? "❯ " : "  "}
							{session.title || "(untitled)"}
						</Text>
						<Text color={COLORS.dim} wrap="truncate">
							{"  "}
							{details.join(" · ")}
						</Text>
					</Box>
				)
			})}
			{windowStart + VISIBLE_ROWS < sessions.length && (
				<Text color={COLORS.dim}>  ↓ {sessions.length - windowStart - VISIBLE_ROWS} more</Text>
			)}
			<Box marginTop={1}>
				<Text color={COLORS.info}>
					↑/↓ select · enter resume{allSessions ? ` · tab ${showAll ? "this directory" : "all directories"}` : ""} · esc cancel
				</Text>
			</Box>
		</PopoverBox>
	)
}
