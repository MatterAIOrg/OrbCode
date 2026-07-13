import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { COLORS } from "../../branding.js"
import type { FollowupSuggestion } from "../../core/events.js"

interface FollowupPromptProps {
	question: string
	suggestions: FollowupSuggestion[]
	onAnswer: (answer: string) => void
}

export function FollowupPrompt({ question, suggestions, onAnswer }: FollowupPromptProps) {
	const [selected, setSelected] = useState(0)
	const [custom, setCustom] = useState("")
	// The last virtual option is free-text input.
	const optionCount = suggestions.length + 1
	const isCustomSelected = selected === suggestions.length

	useInput((input, key) => {
		if (key.upArrow) {
			setSelected((s) => (s - 1 + optionCount) % optionCount)
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((s) => (s + 1) % optionCount)
			return
		}
		if (key.return) {
			if (isCustomSelected) {
				if (custom.trim()) onAnswer(custom.trim())
			} else {
				onAnswer(suggestions[selected].text)
			}
			return
		}
		if (isCustomSelected) {
			if (key.backspace || key.delete) {
				setCustom((c) => c.slice(0, -1))
			} else if (input && !key.ctrl && !key.meta) {
				setCustom((c) => c + input)
			}
		} else if (/^[1-9]$/.test(input)) {
			const index = Number(input) - 1
			if (index < suggestions.length) onAnswer(suggestions[index].text)
		}
	})

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				? {question}
			</Text>
			{suggestions.map((suggestion, index) => (
				<Text key={index} color={selected === index ? COLORS.accent : undefined}>
					{selected === index ? "❯ " : "  "}
					{index + 1}. {suggestion.text}
				</Text>
			))}
			<Text color={isCustomSelected ? COLORS.accent : undefined}>
				{isCustomSelected ? "❯ " : "  "}
				type your own: {custom}
				{isCustomSelected && <Text underline> </Text>}
			</Text>
			<Text color={COLORS.dim}>↑/↓ select · enter confirm · 1-{Math.min(suggestions.length, 9)} quick pick</Text>
		</Box>
	)
}
