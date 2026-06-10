import React from "react"
import { Box, Text, useInput } from "ink"

import { COLORS } from "../../branding.js"
import type { ApprovalDecision, ApprovalRequest } from "../../core/events.js"
import { DiffView, formatToolName } from "./rows.js"

interface ApprovalPromptProps {
	request: ApprovalRequest
	onDecision: (decision: ApprovalDecision) => void
}

export function ApprovalPrompt({ request, onDecision }: ApprovalPromptProps) {
	useInput((input, key) => {
		const lower = input.toLowerCase()
		if (lower === "y" || key.return) onDecision("yes")
		else if (lower === "n" || key.escape) onDecision("no")
		else if (lower === "a" && !request.isDangerous) onDecision("always")
	})

	const title =
		request.kind === "command"
			? request.isDangerous
				? "Run this command? (marked as potentially dangerous)"
				: "Run this command?"
			: `Apply this change? (${formatToolName(request.toolName)})`

	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={request.isDangerous ? COLORS.error : COLORS.warning}
			paddingX={1}
		>
			<Text bold color={request.isDangerous ? COLORS.error : COLORS.warning}>
				{title}
			</Text>
			{request.diff ? (
				<Box paddingLeft={2}>
					<DiffView diff={request.diff} />
				</Box>
			) : (
				<Box paddingLeft={2}>
					<Text>{request.detail}</Text>
				</Box>
			)}
			<Text dimColor>
				(y) yes · (n) no{!request.isDangerous && " · (a) always for this session"}
			</Text>
		</Box>
	)
}
