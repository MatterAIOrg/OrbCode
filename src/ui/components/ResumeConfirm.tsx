import React, { useState } from "react"
import { Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"
import { describeResumeCost, formatIdle, formatTokens, type ResumeCostEstimate } from "../../core/resumeCost.js"
import { PopoverBox } from "./PopoverBox.js"

export type ResumeDecision = "resume" | "new"

interface ResumeConfirmProps {
	estimate: ResumeCostEstimate
	/** The plan share is still being fetched; it fills in when it arrives. */
	estimating?: boolean
	onDecision: (decision: ResumeDecision) => void
	onCancel: () => void
}

const OPTIONS: Array<{ decision: ResumeDecision; label: string; hint?: string }> = [
	{ decision: "resume", label: "Resume" },
	{
		decision: "new",
		label: "Start a new conversation",
		hint: "OrbCode can look this one up if you refer to it later",
	},
]

/**
 * Shown before resuming a session whose prompt cache has expired: the first
 * turn re-reads the whole context at the uncached price, so a long-idle,
 * large session gets a chance to start fresh instead.
 */
export function ResumeConfirm({ estimate, estimating = false, onDecision, onCancel }: ResumeConfirmProps) {
	const [selected, setSelected] = useState(0)

	useInput((input, key) => {
		if (key.upArrow) setSelected((s) => (s - 1 + OPTIONS.length) % OPTIONS.length)
		else if (key.downArrow || key.tab) setSelected((s) => (s + 1) % OPTIONS.length)
		else if (key.return) onDecision(OPTIONS[selected].decision)
		else if (key.escape) onCancel()
		else if (/^[1-9]$/.test(input) && Number(input) <= OPTIONS.length) onDecision(OPTIONS[Number(input) - 1].decision)
	})

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				Resume this conversation?
			</Text>
			<Text> </Text>
			<Text>
				This conversation has been inactive for {formatIdle(estimate.idleMs)} and is{" "}
				{formatTokens(estimate.contextTokens)} tokens long. Resuming it will{" "}
				{describeResumeCost(estimate, estimating)}.
			</Text>
			<Text> </Text>
			{OPTIONS.map((option, i) => {
				const isSelected = i === selected
				return (
					<Text key={option.decision} color={isSelected ? COLORS.accent : undefined}>
						{isSelected ? "❯ " : "  "}
						{i + 1}. {option.label}
						{option.hint && <Text color={COLORS.dim}> · {option.hint}</Text>}
					</Text>
				)
			})}
			<Text color={COLORS.info}>↑/↓ select · enter confirm · esc cancel</Text>
		</PopoverBox>
	)
}
