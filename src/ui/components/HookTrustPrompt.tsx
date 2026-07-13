import React from "react"
import { Box, Text, useInput } from "ink"

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
		<Box flexDirection="column" borderStyle="round" borderColor={COLORS.error} paddingX={1}>
			<Text bold color={COLORS.error}>
				⚠ This project defines {commands.length} hook command{commands.length === 1 ? "" : "s"}
			</Text>
			<Box paddingLeft={2} flexDirection="column">
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
