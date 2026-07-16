import React, { useState } from "react"

import { COLORS } from "../../branding.js"
import { Box, Text, useInput } from "../primitives.js"
import { useTheme, type OrbCodeThemeMode } from "../theme.js"
import { PopoverBox } from "./PopoverBox.js"

const THEMES: Array<{
	id: OrbCodeThemeMode
	label: string
	description: string
}> = [
	{ id: "dark", label: "Dark", description: "OrbCode dark background and high-contrast palette" },
	{ id: "light", label: "Light", description: "White background with OrbCode's light palette" },
]

interface ThemePickerProps {
	current: OrbCodeThemeMode
	onSelect: (mode: OrbCodeThemeMode) => void
	onCancel: () => void
}

export function ThemePicker({ current, onSelect, onCancel }: ThemePickerProps) {
	const theme = useTheme()
	const [selected, setSelected] = useState(() => THEMES.findIndex((option) => option.id === current))

	useInput((input, key) => {
		if (key.upArrow) {
			setSelected((index) => (index - 1 + THEMES.length) % THEMES.length)
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((index) => (index + 1) % THEMES.length)
			return
		}
		if (key.return) {
			onSelect(THEMES[selected].id)
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
		if (input === "1" || input.toLowerCase() === "d") onSelect("dark")
		if (input === "2" || input.toLowerCase() === "l") onSelect("light")
	})

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>Select a theme</Text>
			{THEMES.map((option, index) => {
				const isSelected = index === selected
				const isCurrent = option.id === current
				return (
					<Box
						key={option.id}
						flexDirection="column"
						width="100%"
						backgroundColor={isSelected ? theme.selection : theme.panel}
						shouldFill
					>
						<Text color={isSelected ? COLORS.accent : COLORS.primary}>
							{isSelected ? "❯ " : "  "}{index + 1}. {option.label}
							{isCurrent && <Text color={COLORS.success}> ✓ current</Text>}
						</Text>
						<Box paddingLeft={5}>
							<Text color={COLORS.dim}>{option.description}</Text>
						</Box>
					</Box>
				)
			})}
			<Text color={COLORS.dim}>↑/↓ select · enter confirm · d/l quick select · esc cancel</Text>
		</PopoverBox>
	)
}
