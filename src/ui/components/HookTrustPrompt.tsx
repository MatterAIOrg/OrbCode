import React from "react"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"

interface HookTrustPromptProps {
	/** the workspace whose `.orbcode/settings.json` defines the hooks */
	cwd: string
	/** the shell commands those hooks would run */
	commands: string[]
	onDecision: (trust: boolean) => void
}

const MAX_SHOWN = 8

/**
 * Shown at startup when the current project defines hooks that haven't been
 * trusted yet. Project hooks run arbitrary shell commands, so they stay
 * disabled until the user explicitly approves them here.
 */
export function HookTrustPrompt({ cwd, commands, onDecision }: HookTrustPromptProps) {
	useInput((input, key) => {
		const lower = input.toLowerCase()
		if (lower === "y") onDecision(true)
		else if (lower === "n" || key.escape || key.return) onDecision(false)
	})

	const shown = commands.slice(0, MAX_SHOWN)
	const extra = commands.length - shown.length

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text>
				<Text color={COLORS.error}>◆ </Text>
				<Text bold>Project Hooks</Text>
				<Text color={COLORS.dim}> {commands.length} command{commands.length === 1 ? "" : "s"} require trust</Text>
			</Text>
			<Box paddingLeft={2} flexDirection="column">
				<Text bold color={COLORS.error}>Trust and enable these project hooks?</Text>
				<Text color={COLORS.dim}>{cwd}/.orbcode/settings.json</Text>
				<Text>Project hooks run these shell commands automatically during the session:</Text>
				{shown.map((command, i) => (
					<Text key={i} color={COLORS.warning}>
						{"  • "}
						{command.length > 100 ? command.slice(0, 99) + "…" : command}
					</Text>
				))}
				{extra > 0 && <Text color={COLORS.dim}> … {extra} more</Text>}
			</Box>
			<Text color={COLORS.dim}>
				Only trust hooks from a repository you trust. (y) trust &amp; enable · (n or Enter) keep disabled
			</Text>
		</Box>
	)
}
