import React from "react"
import { Box, Text } from "ink"

import { COLORS } from "../../branding.js"
import { getModel } from "../../api/models.js"

export type ApprovalMode = "ask" | "edits" | "auto"

const MODE_LABELS: Record<ApprovalMode, string> = {
	ask: "⏵ ask before changes",
	edits: "⏵⏵ accept edits on",
	auto: "⏵⏵⏵ auto-approve on",
}

interface StatusBarProps {
	modelId: string
	contextTokens: number
	totalCost: number
	state: string
	approvalMode: ApprovalMode
	busy: boolean
	/** backend-generated session title, once available */
	title?: string
	/** plan name from /axoncode/profile */
	plan?: string
	/** percent of the plan already used, from /axoncode/profile */
	usagePercentage?: number
}

function truncate(text: string, max: number): string {
	return text.length > max ? text.slice(0, max - 1) + "…" : text
}

export function StatusBar({
	modelId,
	contextTokens,
	totalCost,
	state,
	approvalMode,
	busy,
	title,
	plan,
	usagePercentage,
}: StatusBarProps) {
	const model = getModel(modelId)
	const contextPct = Math.min(100, Math.round((contextTokens / model.contextWindow) * 100))
	const remaining =
		typeof usagePercentage === "number" ? Math.max(0, Math.round(100 - usagePercentage)) : undefined
	return (
		<Box flexDirection="column">
			<Box justifyContent="space-between">
				<Text dimColor>
					<Text color={approvalMode === "ask" ? undefined : COLORS.warning}>{MODE_LABELS[approvalMode]}</Text>
					{" (shift+tab to cycle)"}
					{busy && " · esc to interrupt"}
					{state ? <Text color={COLORS.thinking}> · {state}</Text> : null}
				</Text>
				<Text dimColor>
					{title ? `${truncate(title, 32)} · ` : ""}
					{model.name} · ctx {contextTokens.toLocaleString()} ({contextPct}%)
					{model.free ? " · free" : ` · $${totalCost.toFixed(4)}`}
				</Text>
			</Box>
			{(plan || remaining !== undefined) && (
				<Box justifyContent="flex-end">
					<Text dimColor>
						{plan ? `${plan} plan` : ""}
						{plan && remaining !== undefined ? " · " : ""}
						{remaining !== undefined ? (
							<Text color={remaining <= 10 ? COLORS.error : undefined}>{remaining}% usage remaining</Text>
						) : null}
					</Text>
				</Box>
			)}
		</Box>
	)
}
