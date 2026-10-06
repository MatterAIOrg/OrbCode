import React, { useState } from "react"

import { COLORS } from "../../branding.js"
import type { GatewayEffort } from "../../api/models.js"
import { Box, Text, useInput } from "../primitives.js"
import { PopoverBox } from "./PopoverBox.js"

/** "saved": every chat on this machine. "session": this OrbCode process only. */
export type EffortScope = "saved" | "session"

interface EffortPickerProps {
	modelName: string
	levels: GatewayEffort[]
	current: GatewayEffort
	onSelect: (effort: GatewayEffort, scope: EffortScope) => void
	onCancel: () => void
}

const COLUMN_WIDTH = 13
const MIN_TRACK_WIDTH = 36

/**
 * Slider geometry: the track spans `width` columns, the first label starts at
 * its left end, the last ends at its right end, and the others are centred on
 * evenly spaced stops. The ▲ marker sits over the middle of the selected label.
 */
export function effortSliderLayout(levels: readonly string[], selectedIndex: number) {
	const width = Math.max(MIN_TRACK_WIDTH, (levels.length - 1) * COLUMN_WIDTH)
	const step = levels.length > 1 ? width / (levels.length - 1) : 0
	const starts = levels.map((label, i) => {
		if (i === 0) return 0
		if (i === levels.length - 1) return width - label.length
		return Math.round(i * step - label.length / 2)
	})
	const selectedLabel = levels[selectedIndex] ?? ""
	const markerX = (starts[selectedIndex] ?? 0) + Math.floor(selectedLabel.length / 2)
	const line = "─".repeat(markerX) + "▲" + "─".repeat(Math.max(0, width - markerX - 1))
	return { width, starts, markerX, line }
}

export function EffortPicker({ modelName, levels, current, onSelect, onCancel }: EffortPickerProps) {
	const [selected, setSelected] = useState(() => Math.max(0, levels.indexOf(current)))

	useInput((input, key) => {
		if (key.leftArrow) {
			setSelected((index) => Math.max(0, index - 1))
			return
		}
		if (key.rightArrow) {
			setSelected((index) => Math.min(levels.length - 1, index + 1))
			return
		}
		if (key.return) {
			onSelect(levels[selected], "saved")
			return
		}
		if (input === "s") {
			onSelect(levels[selected], "session")
			return
		}
		if (key.escape) onCancel()
	})

	const { width, starts, line } = effortSliderLayout(levels, selected)
	const ends = ["Faster", "Smarter"] as const
	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.dim}>
				Effort<Text color={COLORS.dim}> · {modelName}</Text>
			</Text>
			<Box flexDirection="column" alignItems="center" marginTop={1}>
				<Box flexDirection="column" width={width}>
					<Text color={COLORS.info}>
						{ends[0]}
						{" ".repeat(Math.max(1, width - ends[0].length - ends[1].length))}
						{ends[1]}
					</Text>
					<Text color={COLORS.dim}>{line}</Text>
					<Text>
						{levels.map((level, i) => {
							const previousEnd = i === 0 ? 0 : starts[i - 1] + levels[i - 1].length
							const gap = " ".repeat(Math.max(i === 0 ? 0 : 1, starts[i] - previousEnd))
							return (
								<React.Fragment key={level}>
									{gap}
									{i === selected ? (
										<Text bold color={COLORS.accent}>
											{level}
										</Text>
									) : (
										<Text color={COLORS.dim}>{level}</Text>
									)}
								</React.Fragment>
							)
						})}
					</Text>
				</Box>
			</Box>
			<Box marginTop={1}>
				<Text color={COLORS.dim}>
					←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
				</Text>
			</Box>
		</PopoverBox>
	)
}
