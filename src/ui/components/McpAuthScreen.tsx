import React, { useState } from "react"
import { Box, Text, useInput } from "ink"

import { COLORS } from "../../branding.js"
import { copyToClipboard } from "../../utils/clipboard.js"

interface McpAuthScreenProps {
	/** The server name being authenticated. */
	serverName: string
	/** The authorization URL to display (may be empty until the flow captures it). */
	authUrl: string
	/** Called when the user provides an auth code (from paste). The callback
	 *  server path resolves the same promise in the manager. */
	onPasteCode: (code: string) => void
	/** Called when the user presses Esc to abort. */
	onCancel: () => void
}

/**
 * Shown when the user triggers OAuth authentication for an MCP server. Mirrors
 * Claude Code's auth screen:
 *
 *   - "Authenticating with <server>…"
 *   - "A browser window will open for authentication"
 *   - The authorization URL (with `c` to copy it)
 *   - A paste fallback for when the browser redirect fails
 *   - "Return here after authenticating. Press Esc to go back."
 *
 * The auth code can arrive two ways: the loopback callback server (automatic,
 * handled by the manager) or a manual paste here. Both resolve the same
 * promise, so whichever fires first wins.
 */
export function McpAuthScreen({ serverName, authUrl, onPasteCode, onCancel }: McpAuthScreenProps) {
	const [pasted, setPasted] = useState("")
	const [copied, setCopied] = useState(false)
	const [mode, setMode] = useState<"waiting" | "paste">("waiting")

	useInput((input, key) => {
		if (key.escape) {
			onCancel()
			return
		}
		if (mode === "paste") {
			if (key.return) {
				if (pasted.trim()) onPasteCode(pasted.trim())
				return
			}
			if (key.backspace || key.delete) {
				setPasted((p) => p.slice(0, -1))
				return
			}
			if (input && !key.ctrl && !key.meta) {
				setPasted((p) => p + input)
			}
			return
		}
		// waiting mode
		if (input.toLowerCase() === "c" && authUrl) {
			const ok = copyToClipboard(authUrl)
			setCopied(ok)
			return
		}
		if (key.return) {
			setMode("paste")
		}
	})

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={COLORS.warning} paddingX={1}>
			<Text bold color={COLORS.warning}>
				Authenticating with {serverName}…
			</Text>
			<Text> </Text>
			<Text>
				<Text color={COLORS.thinking}>✽ </Text>
				<Text>A browser window will open for authentication</Text>
			</Text>
			<Text> </Text>
			{authUrl ? (
				<Box flexDirection="column">
					<Text color={COLORS.dim}>
						If your browser doesn't open automatically, copy this URL manually (c to copy)
					</Text>
					<Box paddingLeft={1} marginTop={0}>
						<Text wrap="wrap" color={COLORS.accent}>
							{authUrl}
						</Text>
					</Box>
					{copied && <Text color={COLORS.success}>✓ Copied to clipboard</Text>}
				</Box>
			) : (
				<Text color={COLORS.dim}>Waiting for the authorization URL…</Text>
			)}
			<Text> </Text>
			{mode === "paste" ? (
				<Box flexDirection="column">
					<Text color={COLORS.dim}>If the redirect page shows a connection error, paste the URL from your browser's address bar:</Text>
					<Text>
						<Text color={COLORS.dim}>URL&gt; </Text>
						{pasted}
						<Text underline> </Text>
					</Text>
					<Text color={COLORS.dim}>enter to submit · esc to go back</Text>
				</Box>
			) : (
				<Text color={COLORS.dim}>
					Press enter to paste a redirect URL manually · esc to go back
				</Text>
			)}
			<Text> </Text>
			<Text color={COLORS.dim}>Return here after authenticating in your browser. Press Esc to go back.</Text>
		</Box>
	)
}
