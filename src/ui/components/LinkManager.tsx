import React, { useState } from "react"
import { Box, Text, useInput } from "../primitives.js"

import { COLORS } from "../../branding.js"
import type { LinkedRepo } from "../../config/links.js"
import { PopoverBox } from "./PopoverBox.js"

interface LinkManagerProps {
	links: LinkedRepo[]
	/** Result of the last add/remove, shown under the list. */
	status: string
	onAdd: (input: string) => void
	onRemove: (link: LinkedRepo) => void
	onClose: () => void
}

/**
 * Interactive manager for the `/link` command. The last row is a free-text
 * input where the user types a folder path to add; existing links above it can
 * be selected and removed. Mirrors FollowupPrompt's "input is the final virtual
 * row" pattern.
 */
export function LinkManager({ links, status, onAdd, onRemove, onClose }: LinkManagerProps) {
	const [selected, setSelected] = useState(links.length)
	const [draft, setDraft] = useState("")

	const inputRow = links.length // the free-text row sits after every link
	const rowCount = links.length + 1
	const sel = Math.min(selected, inputRow) // clamp: list shrinks on removal
	const isInput = sel === inputRow

	useInput((input, key) => {
		if (key.escape) {
			onClose()
			return
		}
		if (key.upArrow) {
			setSelected((s) => (Math.min(s, inputRow) - 1 + rowCount) % rowCount)
			return
		}
		if (key.downArrow) {
			setSelected((s) => (Math.min(s, inputRow) + 1) % rowCount)
			return
		}
		if (key.return) {
			if (isInput) {
				if (draft.trim()) {
					onAdd(draft.trim())
					setDraft("")
					// Stay on the input row so several repos can be added in a row.
					// rowCount == the new input-row index once a link is appended.
					setSelected(rowCount)
				}
			} else {
				onRemove(links[sel])
				setSelected(inputRow) // jump back to the input row after removing
			}
			return
		}
		if (isInput) {
			if (key.backspace || key.delete) setDraft((d) => d.slice(0, -1))
			else if (input && !key.ctrl && !key.meta) setDraft((d) => d + input)
		} else if (input === "d" || key.backspace || key.delete) {
			onRemove(links[sel])
			setSelected(inputRow)
		}
	})

	return (
		<PopoverBox flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				Linked repositories
			</Text>
			<Text color={COLORS.dim}>Repos linked here are shared with the agent so changes can be checked across them.</Text>
			{links.length === 0 && <Text color={COLORS.dim}>  (none yet)</Text>}
			{links.map((link, index) => (
				// truncate-start keeps the meaningful tail of long paths visible
				// instead of wrapping them onto the next line.
				<Text key={link.path} color={sel === index ? COLORS.accent : undefined} wrap="truncate-start">
					{sel === index ? "❯ " : "  "}
					{index + 1}. {link.path}
				</Text>
			))}
			<Text color={isInput ? COLORS.accent : undefined}>
				{isInput ? "❯ " : "  "}
				add a repo (folder path):
			</Text>
			{isInput && (
				// The typed/pasted path lives on its own line and truncates from
				// the start, so a long path shows its tail + cursor without wrapping.
				<Text wrap="truncate-start">
					{"    "}
					{draft}
					<Text underline> </Text>
				</Text>
			)}
			{status && <Text color={COLORS.dim}>{status}</Text>}
			<Text color={COLORS.dim}>↑/↓ select · enter add/remove · d remove · esc done</Text>
		</PopoverBox>
	)
}
