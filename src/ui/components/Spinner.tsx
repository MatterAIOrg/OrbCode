import React, { useEffect, useState } from "react"
import { Box, Text } from "../primitives.js"

import { COLORS } from "../../branding.js"

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
export const TIP_DELAY_MS = 2_000

export const TIPS = [
	"Use /help to see every available slash command.",
	"Use /attach to add files or images to your next message.",
	"Use /model to switch the Axon model for this session.",
	"Use /theme to switch between OrbCode's dark and light themes.",
	"Use /clear to clean up the screen without forgetting the conversation.",
	"Use /new to start a fresh conversation with a clean slate.",
	"Use /resume to continue one of your previous sessions.",
	"Use /compact to free up context while keeping the important details.",
	"Use /tasks to check the current task list at any time.",
	"Use /task to bring a previous task from this conversation back into focus.",
	"Use /status to check the active model, context, cost, and account.",
	"Use /usage to check your current plan usage and reset times.",
	"Use /init to create an AGENTS.md tailored to the current codebase.",
	"Use /link to connect related repositories for cross-repo checks.",
	"Use /plugins to browse and manage plugins from the official marketplace.",
	"Use /mcp to enable, disable, reconnect, or inspect MCP servers.",
	"Use /migrate to import MCP servers from Claude Code or Claude Desktop.",
	"Use /commit to review pending changes and prepare detailed commits.",
	"Use /code-review for a focused review of performance, security, bugs, and tests.",
] as const

function pickTip(): string {
	return TIPS[Math.floor(Math.random() * TIPS.length)] ?? TIPS[0]
}

export function Spinner({ label, showTip = false }: { label: string; showTip?: boolean }) {
	const [frame, setFrame] = useState(0)
	const [startedAt] = useState(Date.now())
	const [tip] = useState(pickTip)
	const [tipVisible, setTipVisible] = useState(false)
	const [, setTick] = useState(0)

	useEffect(() => {
		const timer = setInterval(() => {
			setFrame((f) => (f + 1) % FRAMES.length)
			setTick((t) => t + 1)
		}, 80)
		return () => clearInterval(timer)
	}, [])

	useEffect(() => {
		if (!showTip) {
			setTipVisible(false)
			return
		}

		const timer = setTimeout(() => setTipVisible(true), TIP_DELAY_MS)
		return () => clearTimeout(timer)
	}, [showTip])

	const seconds = Math.floor((Date.now() - startedAt) / 1000)
	return (
		<Box flexDirection="column">
			<Text color={COLORS.thinking}>
				{FRAMES[frame]} {label}
				<Text color={COLORS.dim}> ({seconds}s · esc to interrupt)</Text>
			</Text>
			{tipVisible && <Text color={COLORS.dim}>└── TIP: {tip}</Text>}
		</Box>
	)
}
