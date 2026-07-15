import type OpenAI from "openai"

import { callMcpTool, connectMcpServer, type McpConnection } from "./client.js"
import { configPathForScope, loadMcpConfig, removeMcpServerAnyScope } from "./config.js"
import { hasStoredAuth, isOAuthConfig, type AuthIntercept } from "./auth.js"
import type { McpHttpServerConfig, McpServerConfig, McpServerState, McpSnapshot, McpTool, ScopedMcpServerConfig } from "./types.js"

/**
 * Owns the lifecycle of all MCP server connections for a session.
 *
 * On `start()`, it loads the merged config, filters by the enabled/disabled
 * lists, connects to each enabled server in parallel, and exposes the union of
 * their tools as OpenAI-compatible tool definitions. The agent calls
 * `callTool()` for any `mcp__*` tool name; unknown names return an error.
 */
export class McpManager {
	private readonly cwd: string
	private connections = new Map<string, McpConnection>()
	private configs = new Map<string, ScopedMcpServerConfig>()
	private states = new Map<string, McpServerState>()
	/** server names the user has explicitly disabled (persisted in settings). */
	private disabled: Set<string>
	/** server names the user has explicitly enabled (for unapproved project servers). */
	private enabled: Set<string>
	/** project-scope server names that require user approval before connecting. */
	private pendingApproval: Set<string> = new Set()
	private started = false

	constructor(cwd: string, disabled: string[], enabled: string[]) {
		this.cwd = cwd
		this.disabled = new Set(disabled)
		this.enabled = new Set(enabled)
	}

	/** Load config and connect to all approved, non-disabled servers. */
	async start(): Promise<McpSnapshot> {
		if (this.started) return this.snapshot()
		this.started = true
		const { servers } = loadMcpConfig(this.cwd)
		this.configs.clear()
		this.states.clear()
		for (const [name, cfg] of Object.entries(servers)) {
			this.configs.set(name, cfg)
			this.states.set(name, {
				name,
				scope: cfg.scope,
				status: "disabled",
				toolCount: 0,
				disabled: this.disabled.has(name),
				detail: undefined,
			})
		}

		// Project-scope servers need explicit approval (they ship in the repo).
		// User/local-scope servers are trusted (the user wrote them).
		const toConnect: string[] = []
		for (const [name, cfg] of this.configs) {
			if (this.disabled.has(name)) continue
			if (cfg.scope === "project" && !this.enabled.has(name)) {
				this.pendingApproval.add(name)
				this.states.get(name)!.status = "disabled"
				this.states.get(name)!.detail = "awaiting approval"
				continue
			}
			toConnect.push(name)
		}

		// At startup, skip the OAuth browser flow for servers with no stored
		// tokens — mark them needs-auth so the user can auth explicitly from /mcp.
		await Promise.all(toConnect.map((name) => this.connectOne(name, { skipUnauthOAuth: true })))
		return this.snapshot()
	}

	/** Connect (or reconnect) a single server by name.
	 *  When `skipUnauthOAuth` is set, OAuth servers with no stored tokens are
	 *  marked needs-auth instead of opening a browser (used at startup).
	 *  When `authIntercept` is provided, the caller controls the OAuth UI
	 *  (surfacing the auth URL, providing the code via callback or paste).
	 *  When `forceOAuth` is set, an http/sse server without an explicit `oauth`
	 *  config is treated as `oauth: true` (auto-detected OAuth — used when the
	 *  user triggers auth after a 401). */
	async connectOne(name: string, options?: { skipUnauthOAuth?: boolean; authIntercept?: AuthIntercept; forceOAuth?: boolean }): Promise<void> {
		const cfg = this.configs.get(name)
		if (!cfg) return
		const state = this.states.get(name)!
		const isRemote = cfg.type === "http" || cfg.type === "sse"

		// At startup, don't open a browser for OAuth servers that haven't been
		// authenticated yet — surface them as needs-auth so the user can trigger
		// auth explicitly from the /mcp picker. This applies to both explicitly
		// configured OAuth servers and any remote server (which may require OAuth
		// we don't know about yet — we'll find out on the first connect attempt).
		if (options?.skipUnauthOAuth && isOAuthConfig(cfg) && !hasStoredAuth(name)) {
			state.status = "needs-auth"
			state.detail = "not authenticated — press a to authenticate"
			return
		}

		state.status = "connecting"
		state.detail = undefined
		try {
			const { scope: _scope, ...serverConfig } = cfg
			// Auto-detect: if forceOAuth is set and this is a remote server without
			// explicit oauth config, inject oauth: true so the auth transport is used.
			if (options?.forceOAuth && isRemote && !isOAuthConfig(cfg)) {
				;(serverConfig as McpHttpServerConfig).oauth = true
			}
			const connection = await connectMcpServer(name, serverConfig, options?.authIntercept)
			this.connections.set(name, connection)
			state.status = "connected"
			state.toolCount = connection.tools.length
			state.detail = `${connection.tools.length} tool${connection.tools.length === 1 ? "" : "s"}`
			this.pendingApproval.delete(name)
		} catch (error) {
			const msg = (error as Error).message
			// Any remote server that returns 401/unauthorized/invalid_token needs
			// auth — surface as needs-auth regardless of whether `oauth` was
			// explicitly configured (auto-detection, like Claude Code).
			if (isRemote && /unauthorized|auth|401|oauth|invalid_token/i.test(msg)) {
				state.status = "needs-auth"
				state.detail = "authentication required — press a to authenticate"
			} else {
				state.status = "failed"
				state.detail = msg
			}
		}
	}

	/** Disconnect a single server (keeps config; marks it disabled). */
	async disconnectOne(name: string): Promise<void> {
		const connection = this.connections.get(name)
		if (connection) {
			await connection.close()
			this.connections.delete(name)
		}
		const state = this.states.get(name)
		if (state) {
			state.status = "disabled"
			state.toolCount = 0
			state.detail = undefined
		}
	}

	/** Enable a project server (approving it) and connect. Uses
	 *  skipUnauthOAuth so enabling doesn't open a browser — the user auths
	 *  explicitly from /mcp. */
	async enableServer(name: string): Promise<void> {
		this.enabled.add(name)
		this.disabled.delete(name)
		const state = this.states.get(name)
		if (state) state.disabled = false
		await this.connectOne(name, { skipUnauthOAuth: true })
	}

	/** Disable a server and disconnect it. */
	async disableServer(name: string): Promise<void> {
		this.disabled.add(name)
		this.enabled.delete(name)
		const state = this.states.get(name)
		if (state) state.disabled = true
		await this.disconnectOne(name)
	}

	/** Permanently remove a server: disconnect, drop from the in-memory
	 *  config/state, and remove from the on-disk config (whichever scope it
	 *  lives in). Returns true if a config entry was actually removed. The
	 *  caller is responsible for re-persisting the enabled/disabled lists
	 *  (which no longer reference the removed name). */
	async removeServer(name: string): Promise<boolean> {
		await this.disconnectOne(name)
		this.disabled.delete(name)
		this.enabled.delete(name)
		this.pendingApproval.delete(name)
		this.configs.delete(name)
		this.states.delete(name)
		return removeMcpServerAnyScope(this.cwd, name) !== undefined
	}

	/** Re-authenticate a server in the needs-auth state: disconnect, clear
	 *  persisted OAuth tokens, then reconnect with `forceOAuth` so even servers
	 *  without an explicit `oauth` config use the OAuth flow (auto-detect).
	 *  The `authIntercept` lets the TUI surface the auth URL and provide the
	 *  code via callback or paste. */
	async reauthServer(name: string, authIntercept?: AuthIntercept): Promise<void> {
		await this.disconnectOne(name)
		try {
			const fs = await import("node:fs")
			const path = await import("node:path")
			const { getConfigDir } = await import("../config/settings.js")
			fs.unlinkSync(path.join(getConfigDir(), "mcp-auth", `${name}.json`))
		} catch {
			// best-effort; no stored tokens to clear
		}
		this.disabled.delete(name)
		await this.connectOne(name, { authIntercept, forceOAuth: true })
	}

	/** Close every connection. Call on session end / exit. */
	async stop(): Promise<void> {
		await Promise.all(
			[...this.connections.values()].map((c) => c.close().catch(() => {})),
		)
		this.connections.clear()
		this.started = false
	}

	/** All tools from all connected servers, as OpenAI tool definitions. */
	getTools(): OpenAI.Chat.ChatCompletionTool[] {
		const tools: OpenAI.Chat.ChatCompletionTool[] = []
		for (const connection of this.connections.values()) {
			for (const tool of connection.tools) {
				tools.push({
					type: "function",
					function: {
						name: tool.name,
						description: tool.description ?? `MCP tool ${tool.originalName} from server ${tool.server}`,
						parameters: (tool.inputSchema as Record<string, unknown>) ?? {
							type: "object",
							properties: {},
						},
					},
				})
			}
		}
		return tools
	}

	/** Route an `mcp__<server>__<tool>` call to the right connection. */
	async callTool(toolName: string, args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
		if (!toolName.startsWith("mcp__")) {
			return { text: `Invalid MCP tool name: ${toolName}`, isError: true }
		}
		for (const connection of this.connections.values()) {
			const tool = connection.tools.find((candidate) => candidate.name === toolName)
			if (!tool) continue
			try {
				return await callMcpTool(connection, tool.originalName, args)
			} catch (error) {
				return { text: `MCP tool ${toolName} failed: ${(error as Error).message}`, isError: true }
			}
		}
		return { text: `MCP tool "${toolName}" is not connected.`, isError: true }
	}

	/** True if `toolName` is an MCP tool managed by this manager. */
	hasTool(toolName: string): boolean {
		return [...this.connections.values()].some((connection) =>
			connection.tools.some((tool) => tool.name === toolName),
		)
	}

	/** Current snapshot for the TUI / status display. */
	snapshot(): McpSnapshot {
		return {
			servers: [...this.states.values()],
			tools: [...this.connections.values()].flatMap((c) => c.tools),
		}
	}

	/** Project-scope server names awaiting the user's approval. */
	getPendingApproval(): string[] {
		return [...this.pendingApproval]
	}

	/** Persisted enabled list (for saving to settings). */
	getEnabled(): string[] {
		return [...this.enabled]
	}

	/** Persisted disabled list (for saving to settings). */
	getDisabled(): string[] {
		return [...this.disabled]
	}

	/** All configured server names. */
	getServerNames(): string[] {
		return [...this.configs.keys()]
	}

	/** A config by name (for the TUI detail view). */
	getConfig(name: string): ScopedMcpServerConfig | undefined {
		return this.configs.get(name)
	}

	/** The file path where a server's config lives (for the TUI detail view). */
	getConfigPath(name: string): string | undefined {
		const cfg = this.configs.get(name)
		if (!cfg) return undefined
		return configPathForScope(this.cwd, cfg.scope)
	}

	/** True if a server uses OAuth (explicitly configured or auto-detected from
	 *  a 401/needs-auth state). Remote servers in needs-auth state are treated
	 *  as OAuth so the detail panel shows "not authenticated". */
	isOAuthServer(name: string): boolean {
		const cfg = this.configs.get(name)
		if (!cfg) return false
		if (isOAuthConfig(cfg)) return true
		// Auto-detect: a remote server in needs-auth state requires OAuth.
		const state = this.states.get(name)
		if (state?.status === "needs-auth" && (cfg.type === "http" || cfg.type === "sse")) return true
		return false
	}

	/** True if a server has persisted OAuth tokens (already authenticated). */
	isAuthenticated(name: string): boolean {
		return hasStoredAuth(name)
	}
}
