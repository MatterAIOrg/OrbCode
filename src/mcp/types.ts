/**
 * MCP server configuration and connection types.
 *
 * These are OrbCode's own types (not re-exported from the SDK) so the config
 * layer stays decoupled from the SDK's internal schema shape. The connection
 * manager converts these into SDK transports/clients.
 */

/** Where a server config lives, mirroring Claude Code's scoping model. */
export type McpScope = "user" | "project" | "local"

/** A stdio server: OrbCode spawns a child process and talks over stdin/stdout. */
export interface McpStdioServerConfig {
	type?: "stdio"
	command: string
	args?: string[]
	env?: Record<string, string>
	/** Working directory for the spawned process. */
	cwd?: string
}

/** OAuth configuration for a remote (http/sse) MCP server.
 *
 *  - `true` or `{}`: run the interactive authorization-code flow (browser
 *    redirect via a loopback callback server). Use this for servers that
 *    require user login (GitHub, Google Drive, Slack, Notion, …).
 *  - `{ scope }`: same flow with a custom OAuth scope.
 *  - `{ grantType: "client_credentials", clientId, clientSecret }`:
 *    machine-to-machine flow with no browser (uses the SDK's
 *    ClientCredentialsProvider).
 *  - `{ grantType: "private_key_jwt", clientId, privateKey, algorithm }`:
 *    M2M with a signed JWT assertion (RFC 7523). */
export type McpOAuthConfig =
	| boolean
	| {
			/** OAuth scope(s) to request (space-separated). */
			scope?: string
	  }
	| {
			grantType: "client_credentials"
			clientId: string
			clientSecret: string
			scope?: string
	  }
	| {
			grantType: "private_key_jwt"
			clientId: string
			/** PEM-encoded private key (or JWK). */
			privateKey: string | Record<string, unknown>
			/** JWT signing algorithm, e.g. RS256, ES256. */
			algorithm: string
			scope?: string
	  }

/** A Streamable HTTP server (the modern MCP remote transport). */
export interface McpHttpServerConfig {
	type: "http"
	url: string
	headers?: Record<string, string>
	/** OAuth authentication (disables static Authorization header). */
	oauth?: McpOAuthConfig
}

/** A Server-Sent Events server (legacy remote transport, still supported). */
export interface McpSseServerConfig {
	type: "sse"
	url: string
	headers?: Record<string, string>
	/** OAuth authentication (disables static Authorization header). */
	oauth?: McpOAuthConfig
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpSseServerConfig

/** A server config annotated with the scope it was loaded from. */
export type ScopedMcpServerConfig = McpServerConfig & { scope: McpScope }

/** Shape of `.mcp.json` and the `mcpServers` block in settings.json. */
export interface McpJsonConfig {
	mcpServers: Record<string, McpServerConfig>
}

/** A normalized tool surfaced by a connected MCP server. */
export interface McpTool {
	/** Globally-unique tool name: `mcp__<server>__<tool>`. */
	name: string
	/** The original tool name on the server (without the mcp__ prefix). */
	originalName: string
	/** The server that provides this tool. */
	server: string
	description?: string
	inputSchema: Record<string, unknown>
}

/** Connection state for a single MCP server. */
export type McpConnectionStatus =
	| "connecting"
	| "connected"
	| "failed"
	| "disabled"
	| "needs-auth"

export interface McpServerState {
	name: string
	scope: McpScope
	status: McpConnectionStatus
	/** Human-readable detail (error message, server info, …). */
	detail?: string
	/** Number of tools currently exposed by this server. */
	toolCount: number
	/** Whether the user has explicitly disabled this server. */
	disabled: boolean
}

/** Snapshot of all servers + their tools, used by the agent and the TUI. */
export interface McpSnapshot {
	servers: McpServerState[]
	tools: McpTool[]
}
