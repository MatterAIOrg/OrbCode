import React, { useState } from "react"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"
import { BUILTIN_AXON_MODELS, isEidoProAxonModel, isLumenAxonModel, type AxonModel } from "../../api/models.js"
import { PopoverBox } from "./PopoverBox.js"

const VISIBLE_ROWS = 6
const CONTEXT_WINDOW_ORDER = [200000, 400000]
// Display order within a context-window group: Auto, Flash, Mini, Pro, Lumen.
const DISPLAY_ORDER = [
	"axon-auto",
	"axon-eido-3-flash",
	"axon-eido-3-code-mini",
	"axon-eido-3-code-pro",
	"axon-lumen-4-code",
]
function displayRank(modelId: string): number {
	for (let i = 0; i < DISPLAY_ORDER.length; i += 1) {
		if (modelId === DISPLAY_ORDER[i] || modelId.startsWith(`${DISPLAY_ORDER[i]}-`)) return i
	}
	return DISPLAY_ORDER.length
}

interface ModelPickerProps {
	currentId: string
	canUse400k: boolean
	canUseEidoPro: boolean
	canUseLumen: boolean
	onSelect: (modelId: string) => void
	onCancel: () => void
}

function formatPrice(model: AxonModel): string {
	if (model.pricingLabel) return model.pricingLabel
	if (model.free) return "free"
	const perMillion = (price: number) => `$${(price * 1_000_000).toFixed(2)}`
	return `${perMillion(model.inputPrice)} in / ${perMillion(model.outputPrice)} out per 1M tokens`
}

// The context-window header above each group already disambiguates 200k vs
// 400k, so strip the "(NNNK context)" suffix from the row label to avoid
// repeating it. The canonical `model.name` keeps the suffix for the StatusBar
// and /status where the context window isn't shown separately.
function displayName(model: AxonModel): string {
	return model.name.replace(/\s*\(\d+K context\)$/, "")
}

export function ModelPicker({ currentId, canUse400k, canUseEidoPro, canUseLumen, onSelect, onCancel }: ModelPickerProps) {
	const models = Object.values(BUILTIN_AXON_MODELS).sort((a, b) => {
		const aIndex = CONTEXT_WINDOW_ORDER.indexOf(a.contextWindow)
		const bIndex = CONTEXT_WINDOW_ORDER.indexOf(b.contextWindow)
		if (aIndex !== bIndex) {
			return (aIndex === -1 ? CONTEXT_WINDOW_ORDER.length : aIndex) -
				(bIndex === -1 ? CONTEXT_WINDOW_ORDER.length : bIndex)
		}
		return displayRank(a.id) - displayRank(b.id)
	})
	const isLocked = (model: AxonModel) =>
		(model.contextWindow === 400000 && !canUse400k) ||
		(isLumenAxonModel(model.id) && !canUseLumen) ||
		(isEidoProAxonModel(model.id) && !canUseEidoPro)
	const nextSelectableIndex = (from: number, direction: 1 | -1) => {
		for (let offset = 1; offset <= models.length; offset += 1) {
			const candidate = (from + direction * offset + models.length) % models.length
			if (!isLocked(models[candidate])) return candidate
		}
		return from
	}
	const [selected, setSelected] = useState(() => {
		const index = models.findIndex((m) => m.id === currentId)
		return index === -1 || isLocked(models[index]) ? models.findIndex((model) => !isLocked(model)) : index
	})

	useInput((input, key) => {
		if (key.upArrow) {
			setSelected((s) => nextSelectableIndex(s, -1))
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((s) => nextSelectableIndex(s, 1))
			return
		}
		if (key.return) {
			if (!isLocked(models[selected])) onSelect(models[selected].id)
			return
		}
		if (key.escape) {
			onCancel()
			return
		}
		if (/^[1-9]$/.test(input)) {
			const index = Number(input) - 1
			if (index < models.length && !isLocked(models[index])) onSelect(models[index].id)
		}
	})

	// Keep the selection inside the visible window when the list is long.
	const windowStart = Math.max(0, Math.min(selected - VISIBLE_ROWS + 1, models.length - VISIBLE_ROWS))
	const visible = models.slice(windowStart, windowStart + VISIBLE_ROWS)

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				Select a model
			</Text>
			{windowStart > 0 && <Text color={COLORS.dim}>  ↑ {windowStart} more</Text>}
			{visible.map((model, i) => {
				const index = windowStart + i
				const isSelected = index === selected
				const isCurrent = model.id === currentId
				const locked = isLocked(model)
			// The 400k group header already carries the plan note, so only badge
			// rows whose lock isn't explained by the context header.
			const planRestricted =
				(isLumenAxonModel(model.id) && !canUseLumen) ||
				(isEidoProAxonModel(model.id) && !canUseEidoPro)
			const showPlanBadge = planRestricted && !(model.contextWindow === 400000 && !canUse400k)
			const planBadgeText = isLumenAxonModel(model.id) ? "Pro Plus and Ultra only" : "Pro and above only"
				const showContextHeader = i === 0 || visible[i - 1].contextWindow !== model.contextWindow
				const contextLabel = `Context: ${model.contextWindow / 1000}k`
				const contextAccessLabel =
					model.contextWindow === 400000 && !canUse400k
						? `${contextLabel} · Only available in Pro Plus and Ultra plans`
						: contextLabel
				return (
					<React.Fragment key={model.id}>
						{showContextHeader && (
							<Box marginTop={i === 0 ? 0 : 1}>
								<Text bold color={locked ? COLORS.dim : COLORS.primary}>
									{contextAccessLabel}
								</Text>
							</Box>
						)}
						<Box flexDirection="column">
							<Text color={locked ? COLORS.dim : isSelected ? COLORS.accent : undefined}>
								{isSelected ? "❯ " : "  "}
								{index + 1}. {displayName(model)}
								{isCurrent && <Text color={COLORS.success}> ✓ current</Text>}
								<Text color={COLORS.dim}> · {formatPrice(model)}</Text>
								{showPlanBadge && <Text color={COLORS.dim}> · {planBadgeText}</Text>}
							</Text>
							{isSelected && (
								<Box paddingLeft={5}>
									<Text color={COLORS.dim} wrap="wrap">
										{model.description}
									</Text>
								</Box>
							)}
						</Box>
					</React.Fragment>
				)
			})}
			{windowStart + VISIBLE_ROWS < models.length && (
				<Text color={COLORS.dim}>  ↓ {models.length - windowStart - VISIBLE_ROWS} more</Text>
			)}
			<Text color={COLORS.dim}>↑/↓ select · enter confirm · esc cancel</Text>
		</PopoverBox>
	)
}
