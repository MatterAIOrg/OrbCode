import React from "react"
import { Box, Text, useInput } from "ink"

import { COLORS } from "../../branding.js"
import type { ApprovalDecision, ApprovalRequest } from "../../core/events.js"
import { DiffView, formatToolName } from "./rows.js"

interface ApprovalPromptProps {
	request: ApprovalRequest
	onDecision: (decision: ApprovalDecision) => void
	maxDiffLines?: number
	width?: number
}

export function ApprovalPrompt({ request, onDecision, maxDiffLines, width }: ApprovalPromptProps) {
	useInput((input, key) => {
		const lower = input.toLowerCase()
		if (lower === "y" || key.return) onDecision("yes")
		else if (lower === "n" || key.escape) onDecision("no")
		else if (lower === "a" && !request.isDangerous) onDecision("always")
	})

	const question =
		request.kind === "command"
			? request.isDangerous
				? "Run this command? (marked as potentially dangerous)"
				: "Run this command?"
			: "Apply this change?"
	const color = request.isDangerous ? COLORS.error : COLORS.warning
	const diffWidth = width === undefined ? undefined : Math.max(1, width - 2)

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text>
				<Text color={color}>◆ </Text>
				<Text bold>{formatToolName(request.toolName)}</Text>
				<Text color={COLORS.dim}> {request.summary}</Text>
			</Text>
			<Box paddingLeft={2} flexDirection="column">
				<Text bold color={color}>{question}</Text>
				{request.diff ? (
					<DiffView diff={request.diff} maxLines={maxDiffLines} maxWidth={diffWidth} />
				) : (
					<Text>{request.detail}</Text>
				)}
				<Text color={COLORS.dim}>
					(y) yes · (n) no{!request.isDangerous && " · (a) always for this session"}
				</Text>
			</Box>
		</Box>
	)
}
