import React, { useState } from "react"

import { COLORS } from "../../branding.js"
import { Box, Text, useInput } from "../primitives.js"
import { useTheme } from "../theme.js"
import { PopoverBox } from "./PopoverBox.js"

export type MemoryPickerAction = "user" | "project" | "auto-folder" | "claude-folder" | "auto-toggle"

export interface MemoryPickerOption {
	action: MemoryPickerAction
	label: string
	description: string
}

interface MemoryPickerProps {
	options: MemoryPickerOption[]
	onSelect: (action: MemoryPickerAction) => void
	onCancel: () => void
}

/** /memory: open an AGENTS.md or the auto-memory folder, or toggle auto memory. */
export function MemoryPicker({ options, onSelect, onCancel }: MemoryPickerProps) {
	const theme = useTheme()
	const [selected, setSelected] = useState(0)

	useInput((input, key) => {
		if (key.upArrow) {
			setSelected((index) => (index - 1 + options.length) % options.length)
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((index) => (index + 1) % options.length)
			return
		}
		if (key.return) {
			onSelect(options[selected].action)
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
		const quick = Number.parseInt(input, 10)
		if (quick >= 1 && quick <= options.length) onSelect(options[quick - 1].action)
	})

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>Memory</Text>
			{options.map((option, index) => {
				const isSelected = index === selected
				return (
					<Box
						key={option.action}
						flexDirection="column"
						width="100%"
						backgroundColor={isSelected ? theme.selection : theme.panel}
						shouldFill
					>
						<Text color={isSelected ? COLORS.accent : COLORS.primary}>
							{isSelected ? "❯ " : "  "}{index + 1}. {option.label}
						</Text>
						<Box paddingLeft={5}>
							<Text color={COLORS.dim}>{option.description}</Text>
						</Box>
					</Box>
				)
			})}
			<Box marginTop={1}>
				<Text color={COLORS.dim}>↑/↓ select · enter confirm · esc cancel</Text>
			</Box>
		</PopoverBox>
	)
}
