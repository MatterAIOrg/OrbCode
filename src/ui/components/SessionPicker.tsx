import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { COLORS } from "../../branding.js"
import type { SessionData } from "../../core/sessions.js"

const VISIBLE_ROWS = 8

interface SessionPickerProps {
	sessions: SessionData[]
	onSelect: (session: SessionData) => void
	onCancel: () => void
	title?: string
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

export function SessionPicker({ sessions, onSelect, onCancel, title = "Resume a previous session" }: SessionPickerProps) {
	const [selected, setSelected] = useState(0)

	useInput((input, key) => {
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
		<Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				{title}
			</Text>
			{windowStart > 0 && <Text dimColor>  ↑ {windowStart} more</Text>}
			{visible.map((session, i) => {
				const index = windowStart + i
				const isSelected = index === selected
				const userTurns = session.messages.filter((m) => m.role === "user").length
				return (
					<Text key={session.id} color={isSelected ? COLORS.accent : undefined}>
						{isSelected ? "❯ " : "  "}
						{index + 1}. {session.title || "(untitled)"}
						<Text dimColor>
							{" "}
							· {relativeTime(session.updatedAt)} · {userTurns} message{userTurns === 1 ? "" : "s"}
						</Text>
					</Text>
				)
			})}
			{windowStart + VISIBLE_ROWS < sessions.length && (
				<Text dimColor>  ↓ {sessions.length - windowStart - VISIBLE_ROWS} more</Text>
			)}
			<Text dimColor>↑/↓ select · enter resume · esc cancel</Text>
		</Box>
	)
}
