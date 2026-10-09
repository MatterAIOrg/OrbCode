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

/** "45s", "2m 13s", "1h 4m" */
export function formatElapsed(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000))
	if (seconds < 60) return `${seconds}s`
	const minutes = Math.floor(seconds / 60)
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "840", "4.2k", "1.3M" */
export function formatTokenCount(tokens: number): string {
	if (tokens < 1000) return String(Math.round(tokens))
	if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`
	return `${(tokens / 1_000_000).toFixed(1)}M`
}

interface SpinnerProps {
	label: string
	showTip?: boolean
	/** Start of the whole turn, so the timer survives label changes. Defaults to mount time. */
	startedAt?: number
	/** Output tokens generated this turn; read on every frame so it counts up live. */
	tokensRef?: { readonly current: number }
}

export function Spinner({ label, showTip = false, startedAt: turnStartedAt, tokensRef }: SpinnerProps) {
	const [frame, setFrame] = useState(0)
	const [mountedAt] = useState(Date.now())
	const startedAt = turnStartedAt ?? mountedAt
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

	const tokens = tokensRef?.current ?? 0
	return (
		<Box flexDirection="column">
			<Text color={COLORS.thinking}>
				{FRAMES[frame]} {label}…
				<Text color={COLORS.dim}>
					{" "}({formatElapsed(Date.now() - startedAt)}
					{tokens > 0 ? ` · ↓ ${formatTokenCount(tokens)} tokens` : ""} · esc to interrupt)
				</Text>
			</Text>
			{tipVisible && <Text color={COLORS.info}>└── TIP: {tip}</Text>}
		</Box>
	)
}
