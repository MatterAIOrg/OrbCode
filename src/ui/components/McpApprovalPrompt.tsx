import React, { useState } from "react"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"

const VISIBLE_ROWS = 8

interface McpApprovalPromptProps {
	/** Project-scope server names found in .mcp.json that need approval. */
	serverNames: string[]
	/** Called with the subset the user approved (may be empty). */
	onApprove: (approved: string[]) => void
}

/**
 * Shown at startup when the project's `.mcp.json` defines servers that haven't
 * been approved yet. Project-scope servers ship in the repo and can spawn
 * processes / open network connections, so they require explicit per-project
 * approval — mirroring Claude Code's `.mcp.json` approval dialog.
 *
 * The user toggles servers with Space and confirms with Enter; Escape rejects
 * all. Approved servers are persisted to `.orbcode/settings.json` so they
 * auto-connect on future sessions in this project.
 */
export function McpApprovalPrompt({ serverNames, onApprove }: McpApprovalPromptProps) {
	const [selected, setSelected] = useState(0)
	const [checked, setChecked] = useState<Set<string>>(new Set(serverNames))

	useInput((input, key) => {
		if (key.upArrow) {
			setSelected((s) => (s - 1 + serverNames.length) % serverNames.length)
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((s) => (s + 1) % serverNames.length)
			return
		}
		if (key.escape) {
			onApprove([])
			return
		}
		if (key.return) {
			onApprove([...checked])
			return
		}
		if (input === " ") {
			const name = serverNames[selected]
			if (!name) return
			setChecked((prev) => {
				const next = new Set(prev)
				if (next.has(name)) next.delete(name)
				else next.add(name)
				return next
			})
		}
	})

	if (serverNames.length === 0) return null

	const count = serverNames.length
	const windowStart = Math.max(0, Math.min(selected - VISIBLE_ROWS + 1, count - VISIBLE_ROWS))
	const visible = serverNames.slice(windowStart, windowStart + VISIBLE_ROWS)

	return (
		<Box flexDirection="column" marginTop={1}>
			<Text>
				<Text color={COLORS.warning}>◆ </Text>
				<Text bold>MCP Servers</Text>
				<Text color={COLORS.dim}> {count} project server{count === 1 ? "" : "s"} require approval</Text>
			</Text>
			<Box paddingLeft={2} flexDirection="column">
				<Text bold color={COLORS.warning}>Enable servers from this project's .mcp.json?</Text>
				<Text color={COLORS.dim}>Select only servers you trust.</Text>
				{windowStart > 0 && <Text color={COLORS.dim}>  ↑ {windowStart} more</Text>}
				{visible.map((name, i) => {
					const index = windowStart + i
					const isSelected = index === selected
					const isChecked = checked.has(name)
					return (
						<Text key={name} color={isSelected ? COLORS.accent : undefined}>
							{isSelected ? "❯ " : "  "}
							{isChecked ? "☑" : "☐"} {name}
						</Text>
					)
				})}
				{windowStart + VISIBLE_ROWS < count && (
					<Text color={COLORS.dim}>  ↓ {count - windowStart - VISIBLE_ROWS} more</Text>
				)}
				<Text color={COLORS.dim}>space toggle · enter confirm · esc reject all</Text>
			</Box>
		</Box>
	)
}
