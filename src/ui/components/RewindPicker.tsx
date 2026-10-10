import React, { useState } from "react"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"
import type { RewindMode, RewindPoint } from "../../core/checkpoints.js"
import { PopoverBox } from "./PopoverBox.js"

const VISIBLE_ROWS = 5

interface RewindPickerProps {
	/** user turns that can be rewound to, oldest first */
	points: RewindPoint[]
	onSelect: (point: RewindPoint, mode: RewindMode) => void
	onCancel: () => void
}

const MODES: { mode: RewindMode; label: string }[] = [
	{ mode: "both", label: "Restore code and conversation" },
	{ mode: "conversation", label: "Restore conversation" },
	{ mode: "code", label: "Restore code" },
]

/** First line of a prompt, shortened to fit one row. */
function preview(point: RewindPoint, max: number): string {
	const line = point.text.split("\n").find((l) => l.trim())?.trim() ?? ""
	const text = line || (point.attachments?.length ? "(attachments only)" : "(empty)")
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function changeSummary(point: RewindPoint): string {
	const count = point.changedFiles.length
	return count === 0 ? "No code changes" : `${count} file${count === 1 ? "" : "s"} changed`
}

/** Pick a user message to rewind to, then (when files changed since) what to restore. */
export function RewindPicker({ points, onSelect, onCancel }: RewindPickerProps) {
	// The last row is "(current)": the present moment, which does nothing.
	const [selected, setSelected] = useState(points.length)
	const [chosen, setChosen] = useState<RewindPoint | null>(null)
	const [modeIndex, setModeIndex] = useState(0)

	useInput((input, key) => {
		if (chosen) {
			const options = MODES.length + 1
			if (key.escape) {
				setChosen(null)
			} else if (key.upArrow) {
				setModeIndex((i) => (i - 1 + options) % options)
			} else if (key.downArrow || key.tab) {
				setModeIndex((i) => (i + 1) % options)
			} else if (key.return) {
				if (modeIndex < MODES.length) onSelect(chosen, MODES[modeIndex].mode)
				else setChosen(null)
			}
			return
		}
		if (key.escape) {
			onCancel()
		} else if (key.upArrow) {
			setSelected((s) => (s - 1 + points.length + 1) % (points.length + 1))
		} else if (key.downArrow || key.tab) {
			setSelected((s) => (s + 1) % (points.length + 1))
		} else if (key.return) {
			const point = points[selected]
			if (!point) onCancel()
			else if (point.changedFiles.length === 0) onSelect(point, "conversation")
			else {
				setChosen(point)
				setModeIndex(0)
			}
		}
	})

	if (chosen) {
		return (
			<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
				<Text bold color={COLORS.primary}>
					Rewind
				</Text>
				<Text color={COLORS.dim}>Before: {preview(chosen, 70)}</Text>
				<Text color={COLORS.dim}>{changeSummary(chosen)} (edits made through Bash can't be restored)</Text>
				<Box height={1} />
				{[...MODES.map((m) => m.label), "Never mind"].map((label, i) => (
					<Text key={label} color={i === modeIndex ? COLORS.accent : undefined}>
						{i === modeIndex ? "❯ " : "  "}
						{i + 1}. {label}
					</Text>
				))}
				<Box marginTop={1}>
					<Text color={COLORS.info}>↑/↓ select · enter confirm · esc back</Text>
				</Box>
			</PopoverBox>
		)
	}

	const total = points.length + 1
	const windowStart = Math.max(0, Math.min(selected - VISIBLE_ROWS + 1, total - VISIBLE_ROWS))
	const visible = Array.from({ length: Math.min(VISIBLE_ROWS, total) }, (_, i) => windowStart + i)

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				Rewind
			</Text>
			<Text color={COLORS.dim}>Restore the code and/or conversation to the point before…</Text>
			<Box height={1} />
			{windowStart > 0 && <Text color={COLORS.dim}>  ↑ {windowStart} more</Text>}
			{visible.map((index, i) => {
				const point = points[index]
				const isSelected = index === selected
				const color = isSelected ? COLORS.accent : undefined
				if (!point) {
					return (
						<Box key="current" marginTop={i === 0 ? 0 : 1}>
							<Text color={color} italic>
								{isSelected ? "❯ " : "  "}(current)
							</Text>
						</Box>
					)
				}
				return (
					<Box key={point.id} flexDirection="column" marginTop={i === 0 ? 0 : 1}>
						<Text color={color}>
							{isSelected ? "❯ " : "  "}
							{preview(point, 80)}
						</Text>
						<Text color={COLORS.dim}>  {changeSummary(point)}</Text>
					</Box>
				)
			})}
			{windowStart + VISIBLE_ROWS < total && (
				<Text color={COLORS.dim}>  ↓ {total - windowStart - VISIBLE_ROWS} more</Text>
			)}
			<Box marginTop={1}>
				<Text color={COLORS.info}>↑/↓ select · enter continue · esc cancel</Text>
			</Box>
		</PopoverBox>
	)
}
