import React, { useRef, useState } from "react"
import { Box, Text, useInput } from "ink"

import { COLORS } from "../../branding.js"
import type { AuthIntercept } from "../../mcp/auth.js"
import type { McpManager } from "../../mcp/manager.js"
import type { McpServerState } from "../../mcp/types.js"
import { McpAuthScreen } from "./McpAuthScreen.js"

const VISIBLE_ROWS = 8

interface McpPickerProps {
	manager: McpManager
	onChanged: () => void
	onCancel: () => void
}

function statusColor(state: McpServerState): string {
	switch (state.status) {
		case "connected":
			return COLORS.success
		case "connecting":
			return COLORS.warning
		case "failed":
			return COLORS.error
		case "needs-auth":
			return COLORS.warning
		case "disabled":
			return COLORS.dim
	}
}

function statusIcon(state: McpServerState): string {
	switch (state.status) {
		case "connected":
			return "✓"
		case "connecting":
			return "⋯"
		case "failed":
			return "✗"
		case "needs-auth":
			return "△"
		case "disabled":
			return "○"
	}
}

/** Build the action list for a server based on its current state. */
function buildActions(state: McpServerState): string[] {
	const actions: string[] = []
	if (state.status === "needs-auth") actions.push("Authenticate")
	if (state.disabled || state.status === "disabled") actions.push("Enable")
	else actions.push("Disable")
	actions.push("Reconnect")
	return actions
}

/**
 * Interactive MCP server manager, opened by the `/mcp` command.
 *
 * Two-level navigation (arrow keys + enter only, no shorthand keys):
 *   - Server list: ↑/↓ to select a server, enter to open its action menu.
 *   - Action menu: ↑/↓ to select an action, enter to execute, esc to go back.
 *
 * Actions adapt to the server's state: Authenticate (needs-auth), Enable
 * (disabled), Disable (connected/failed), Reconnect (always).
 */
export function McpPicker({ manager, onChanged, onCancel }: McpPickerProps) {
	const [snapshot, setSnapshot] = useState(() => manager.snapshot())
	const [selected, setSelected] = useState(0)
	const [busy, setBusy] = useState(false)
	const [busyMessage, setBusyMessage] = useState("")
	const [authingServer, setAuthingServer] = useState<string | null>(null)
	const [authUrl, setAuthUrl] = useState("")
	const [actionMode, setActionMode] = useState(false)
	const [actionSelected, setActionSelected] = useState(0)
	const codeResolveRef = useRef<((code: string) => void) | null>(null)
	const codeRejectRef = useRef<((reason: Error) => void) | null>(null)

	const servers = snapshot.servers
	const count = servers.length
	const current = servers[selected]
	const actions = current ? buildActions(current) : []

	useInput((_input, key) => {
		if (authingServer || busy) return

		if (actionMode) {
			if (key.escape) {
				setActionMode(false)
				return
			}
			if (key.upArrow) {
				setActionSelected((s) => (s - 1 + actions.length) % actions.length)
				return
			}
			if (key.downArrow || key.tab) {
				setActionSelected((s) => (s + 1) % actions.length)
				return
			}
			if (key.return) {
				void executeAction(actions[actionSelected])
				return
			}
			return
		}

		// Server list navigation.
		if (key.escape) {
			onCancel()
			return
		}
		if (key.upArrow) {
			setSelected((s) => (s - 1 + count) % count)
			return
		}
		if (key.downArrow || key.tab) {
			setSelected((s) => (s + 1) % count)
			return
		}
		if (key.return) {
			setActionMode(true)
			setActionSelected(0)
			return
		}
	})

	async function refresh(): Promise<void> {
		setSnapshot(manager.snapshot())
		onChanged()
	}

	async function executeAction(action: string | undefined): Promise<void> {
		if (!action || !current) return
		setActionMode(false)
		if (action === "Authenticate") await reauthSelected()
		else if (action === "Enable") await enableSelected()
		else if (action === "Disable") await disableSelected()
		else if (action === "Reconnect") await reconnectSelected()
	}

	async function enableSelected(): Promise<void> {
		if (!current) return
		setBusy(true)
		setBusyMessage("Enabling…")
		try {
			await manager.enableServer(current.name)
			await refresh()
		} finally {
			setBusy(false)
			setBusyMessage("")
		}
	}

	async function disableSelected(): Promise<void> {
		if (!current) return
		setBusy(true)
		setBusyMessage("Disabling…")
		try {
			await manager.disableServer(current.name)
			await refresh()
		} finally {
			setBusy(false)
			setBusyMessage("")
		}
	}

	async function reconnectSelected(): Promise<void> {
		if (!current) return
		setBusy(true)
		setBusyMessage("Reconnecting…")
		try {
			await manager.disconnectOne(current.name)
			await manager.connectOne(current.name)
			await refresh()
		} finally {
			setBusy(false)
			setBusyMessage("")
		}
	}

	async function reauthSelected(): Promise<void> {
		if (!current) return
		const intercept: AuthIntercept = {
			onAuthUrl: (url) => setAuthUrl(url),
			getCode: () =>
				new Promise<string>((resolve, reject) => {
					codeResolveRef.current = resolve
					codeRejectRef.current = reject
				}),
		}
		setAuthingServer(current.name)
		setAuthUrl("")
		setBusy(true)
		try {
			await manager.reauthServer(current.name, intercept)
			await refresh()
		} catch {
			// auth failed or cancelled; server stays needs-auth
		} finally {
			setAuthingServer(null)
			setAuthUrl("")
			codeResolveRef.current = null
			codeRejectRef.current = null
			setBusy(false)
		}
	}

	function handlePasteCode(input: string): void {
		try {
			const url = new URL(input)
			const code = url.searchParams.get("code")
			if (code) {
				codeResolveRef.current?.(code)
				return
			}
		} catch {
			// not a URL — treat as bare code
		}
		codeResolveRef.current?.(input)
	}

	function handleAuthCancel(): void {
		codeRejectRef.current?.(new Error("Authentication cancelled."))
	}

	if (count === 0) {
		return (
			<Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
				<Text bold color={COLORS.primary}>
					MCP servers
				</Text>
				<Text dimColor>No MCP servers configured.</Text>
				<Text dimColor>
					Add servers with: orbcode mcp add &lt;name&gt; &lt;command&gt; [args...]
				</Text>
				<Text dimColor>esc to close</Text>
			</Box>
		)
	}

	if (authingServer) {
		return (
			<McpAuthScreen
				serverName={authingServer}
				authUrl={authUrl}
				onPasteCode={handlePasteCode}
				onCancel={handleAuthCancel}
			/>
		)
	}

	const windowStart = Math.max(0, Math.min(selected - VISIBLE_ROWS + 1, count - VISIBLE_ROWS))
	const visible = servers.slice(windowStart, windowStart + VISIBLE_ROWS)

	return (
		<Box flexDirection="column" borderStyle="round" borderColor={COLORS.primary} paddingX={1}>
			<Text bold color={COLORS.primary}>
				Manage MCP servers ({count})
			</Text>
			{windowStart > 0 && <Text dimColor>  ↑ {windowStart} more</Text>}
			{visible.map((state, i) => {
				const index = windowStart + i
				const isSelected = index === selected && !actionMode
				return (
					<Text key={state.name} color={isSelected ? COLORS.accent : undefined}>
						{isSelected ? "❯ " : "  "}
						{state.name}
						{"  "}
						<Text color={statusColor(state)}>
							{statusIcon(state)} {state.status}
						</Text>
						{state.toolCount > 0 && <Text dimColor> · {state.toolCount} tools</Text>}
					</Text>
				)
			})}
			{windowStart + VISIBLE_ROWS < count && (
				<Text dimColor>  ↓ {count - windowStart - VISIBLE_ROWS} more</Text>
			)}
			{current && (
				<DetailPanel
					manager={manager}
					state={current}
					actions={actions}
					actionMode={actionMode}
					actionSelected={actionSelected}
				/>
			)}
			<Text dimColor>
				{busy
					? busyMessage
					: actionMode
						? "↑/↓ select action · enter execute · esc back"
						: "↑/↓ select server · enter open actions · esc close"}
			</Text>
		</Box>
	)
}

function DetailPanel({
	manager,
	state,
	actions,
	actionMode,
	actionSelected,
}: {
	manager: McpManager
	state: McpServerState
	actions: string[]
	actionMode: boolean
	actionSelected: number
}) {
	const cfg = manager.getConfig(state.name)
	const configPath = manager.getConfigPath(state.name)
	const isOAuth = manager.isOAuthServer(state.name)
	const authenticated = manager.isAuthenticated(state.name)

	const authText = !isOAuth
		? "— (static / stdio)"
		: authenticated
			? "✓ authenticated"
			: "✗ not authenticated"

	let urlText: string
	if (cfg && (cfg.type === "http" || cfg.type === "sse")) {
		urlText = cfg.url
	} else if (cfg) {
		const cmd = cfg.command
		const args = cfg.args ?? []
		urlText = `stdio: ${cmd}${args.length ? " " + args.join(" ") : ""}`
	} else {
		urlText = ""
	}

	return (
		<Box paddingLeft={1} marginTop={1} flexDirection="column">
			<Text bold>
				{state.name} MCP Server
			</Text>
			<Text>
				<Text dimColor>Status:          </Text>
				<Text color={statusColor(state)}>{statusIcon(state)} {state.status}</Text>
			</Text>
			<Text>
				<Text dimColor>Auth:            </Text>
				<Text color={isOAuth && !authenticated ? COLORS.error : isOAuth ? COLORS.success : COLORS.dim}>
					{authText}
				</Text>
			</Text>
			<Text>
				<Text dimColor>URL:             </Text>
				{urlText}
			</Text>
			{configPath && (
				<Text>
					<Text dimColor>Config location: </Text>
					<Text dimColor>{configPath}</Text>
				</Text>
			)}
			{state.detail && (
				<Text color={state.status === "failed" ? COLORS.error : state.status === "needs-auth" ? COLORS.warning : COLORS.dim}>
					{state.detail}
				</Text>
			)}
			<Box marginTop={1} flexDirection="column">
				{actions.map((action, i) => {
					const isSelected = actionMode && i === actionSelected
					return (
						<Text key={action} color={isSelected ? COLORS.accent : undefined}>
							{isSelected ? "❯ " : "  "}
							{i + 1}. {action}
						</Text>
					)
				})}
			</Box>
		</Box>
	)
}
