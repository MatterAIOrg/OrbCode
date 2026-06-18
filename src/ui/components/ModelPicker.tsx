import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { COLORS } from "../../branding.js"
import { BUILTIN_AXON_MODELS, type AxonModel } from "../../api/models.js"

const VISIBLE_ROWS = 6

interface ModelPickerProps {
	currentId: string
	onSelect: (modelId: string) => void
	onCancel: () => void
}

function formatPrice(model: AxonModel): string {
	if (model.free) return "free"
	const perMillion = (price: number) => `$${(price * 1_000_000).toFixed(2)}`
	return `${perMillion(model.inputPrice)} in / ${perMillion(model.outputPrice)} out per 1M tokens`
}

export function ModelPicker({ currentId, onSelect, onCancel }: ModelPickerProps) {
	const models = Object.values(BUILTIN_AXON_MODELS)
	const [selected, setSelected] = useState(() => {
		const index = models.findIndex((m) => m.id === currentId)
		return index === -1 ? 0 : index
	})

	useInput((input, key) => {
		if (key.upArrow) {
			setSelected((s) => (s - 1 + models.length) % models.length)
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((s) => (s + 1) % models.length)
			return
		}
		if (key.return) {
			onSelect(models[selected].id)
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
		if (/^[1-9]$/.test(input)) {
			const index = Number(input) - 1
			if (index < models.length) onSelect(models[index].id)
		}
	})

	// Keep the selection inside the visible window when the list is long.
	const windowStart = Math.max(0, Math.min(selected - VISIBLE_ROWS + 1, models.length - VISIBLE_ROWS))
	const visible = models.slice(windowStart, windowStart + VISIBLE_ROWS)

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				Select a model
			</Text>
			{windowStart > 0 && <Text dimColor>  ↑ {windowStart} more</Text>}
			{visible.map((model, i) => {
				const index = windowStart + i
				const isSelected = index === selected
				const isCurrent = model.id === currentId
				return (
					<Box key={model.id} flexDirection="column">
						<Text color={isSelected ? COLORS.accent : undefined}>
							{isSelected ? "❯ " : "  "}
							{index + 1}. {model.name}
							{isCurrent && <Text color={COLORS.success}> ✓ current</Text>}
							<Text dimColor> · {formatPrice(model)}</Text>
						</Text>
						{isSelected && (
							<Box paddingLeft={5}>
								<Text dimColor wrap="wrap">
									{model.description}
								</Text>
							</Box>
						)}
					</Box>
				)
			})}
			{windowStart + VISIBLE_ROWS < models.length && (
				<Text dimColor>  ↓ {models.length - windowStart - VISIBLE_ROWS} more</Text>
			)}
			<Text dimColor>↑/↓ select · enter confirm · esc cancel</Text>
		</Box>
	)
}
