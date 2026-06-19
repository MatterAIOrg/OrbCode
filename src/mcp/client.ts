import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

import { VERSION } from "../branding.js"
import type { McpServerConfig, McpTool } from "./types.js"
import { createAuthTransport, hasOAuth, type AuthIntercept } from "./auth.js"

/** The SDK transport type (union of the three we use). */
type AnyTransport = StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport

/** Build the SDK transport for a server config. For http/sse servers with an
 *  `oauth` block, returns an auth-aware transport whose `authenticate()` runs
 *  the OAuth flow (browser redirect or M2M) before `start()`. */
function buildTransport(name: string, config: McpServerConfig, intercept?: AuthIntercept): {
	transport: AnyTransport
	authenticate?: () => Promise<void>
} {
	if (config.type === "sse") {
		if (hasOAuth(config)) {
			const auth = createAuthTransport(name, new URL(config.url), "sse", config.oauth!, {
				headers: config.headers ?? {},
			}, intercept)
			return { transport: auth.transport, authenticate: auth.authenticate }
		}
		return {
			transport: new SSEClientTransport(new URL(config.url), {
				requestInit: { headers: config.headers ?? {} },
			}),
		}
	}
	if (config.type === "http") {
		if (hasOAuth(config)) {
			const auth = createAuthTransport(name, new URL(config.url), "http", config.oauth!, {
				headers: config.headers ?? {},
			}, intercept)
			return { transport: auth.transport, authenticate: auth.authenticate }
		}
		return {
			transport: new StreamableHTTPClientTransport(new URL(config.url), {
				requestInit: { headers: config.headers ?? {} },
			}),
		}
	}
	// stdio (default)
	return {
		transport: new StdioClientTransport({
			command: config.command,
			args: config.args ?? [],
			env: config.env,
			cwd: config.cwd,
			stderr: "pipe",
		}),
	}
}

/** A live connection to a single MCP server. */
export interface McpConnection {
	client: Client
	tools: McpTool[]
	/** Close the transport and free the child process / socket. */
	close: () => Promise<void>
}

const CONNECT_TIMEOUT_MS = 30_000
const CLIENT_INFO = { name: "orbcode", version: VERSION }

/** Connect to one MCP server and enumerate its tools. The optional
 *  `authIntercept` lets the caller surface the OAuth URL in the TUI and
 *  provide the auth code (from the callback or a manual paste). */
export async function connectMcpServer(name: string, config: McpServerConfig, authIntercept?: AuthIntercept): Promise<McpConnection> {
	const { transport, authenticate } = buildTransport(name, config, authIntercept)
	const client = new Client(CLIENT_INFO, { capabilities: {} })

	// For OAuth servers, run the auth flow (browser redirect or M2M) before
	// connecting. This may open a browser and block until the user authorizes.
	if (authenticate) {
		await withTimeout(authenticate(), CONNECT_TIMEOUT_MS, `MCP server "${name}" auth timed out`)
	}

	// Wrap connect in a timeout so a hung server doesn't block startup.
	await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `MCP server "${name}" timed out`)

	const tools = await listServerTools(name, client)
	return {
		client,
		tools,
		close: async () => {
			try {
				await transport.close()
			} catch {
				// best-effort
			}
			try {
				await client.close()
			} catch {
				// best-effort
			}
		},
	}
}

/** Enumerate tools from a connected client, namespaced as mcp__<server>__<tool>. */
export async function listServerTools(server: string, client: Client): Promise<McpTool[]> {
	const result = await client.listTools()
	return (result.tools ?? []).map((tool) => ({
		name: `mcp__${server}__${tool.name}`,
		originalName: tool.name,
		server,
		description: tool.description,
		inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
	}))
}

/** Call a tool on a connected client and return a text result for the model. */
export async function callMcpTool(
	connection: McpConnection,
	originalName: string,
	args: Record<string, unknown>,
): Promise<{ text: string; isError?: boolean }> {
	const result = await connection.client.callTool({ name: originalName, arguments: args })
	const content = (result.content ?? []) as Array<Record<string, unknown>>
	const parts: string[] = []
	for (const block of content) {
		const type = block.type as string
		if (type === "text" && typeof block.text === "string") {
			parts.push(block.text)
		} else if (type === "resource") {
			const resource = block.resource as Record<string, unknown> | undefined
			if (resource && typeof resource.text === "string") parts.push(resource.text)
		} else if (type === "image") {
			parts.push(`[image: ${block.mimeType}]`)
		} else if (type === "audio") {
			parts.push(`[audio: ${block.mimeType}]`)
		} else if (type === "resource_link" && typeof block.uri === "string") {
			parts.push(`[resource: ${block.uri}]`)
		}
	}
	const text = parts.join("\n") || "(empty MCP tool result)"
	return { text, isError: Boolean(result.isError) }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const cap = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(message)), ms)
		timer.unref?.()
	})
	return Promise.race([promise, cap]).finally(() => {
		if (timer) clearTimeout(timer)
	}) as Promise<T>
}
