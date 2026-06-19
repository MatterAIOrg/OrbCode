import {
	addMcpServer,
	configPathForScope,
	loadMcpConfig,
	removeMcpServerAnyScope,
} from "../mcp/config.js"
import type { McpHttpServerConfig, McpScope, McpServerConfig, McpSseServerConfig, McpStdioServerConfig } from "../mcp/types.js"

/**
 * `orbcode mcp` subcommand — manage MCP servers from the command line, like
 * Claude Code's `claude mcp add/remove/list`.
 *
 * Usage:
 *   orbcode mcp add <name> <command> [args...]                    stdio (default)
 *   orbcode mcp add --transport http <name> <url>                  http
 *   orbcode mcp add --transport sse <name> <url>                   sse
 *   orbcode mcp add -s <scope> -e KEY=value ... <name> ...         with scope/env
 *   orbcode mcp add --header KEY=value ... <name> <url>            http/sse headers
 *   orbcode mcp remove <name>                                      remove from any scope
 *   orbcode mcp list                                               list all servers
 *
 * Flags:
 *   -s, --scope <user|project|local>   config scope (default: project)
 *   -t, --transport <stdio|http|sse>   transport type (default: stdio)
 *   -e, --env KEY=value                environment variable (repeatable, stdio)
 *       --header KEY=value             HTTP header (repeatable, http/sse)
 *       --oauth                        enable OAuth for http/sse
 *       --oauth-scope <scope>          OAuth scope (implies --oauth)
 */

const VALID_SCOPES: McpScope[] = ["user", "project", "local"]
const VALID_TRANSPORTS = ["stdio", "http", "sse"] as const

/** Parse a KEY=value pair from a flag argument. */
function parseKeyValue(arg: string): [string, string] {
	const idx = arg.indexOf("=")
	if (idx === -1) throw new Error(`Expected KEY=value, got "${arg}"`)
	return [arg.slice(0, idx), arg.slice(idx + 1)]
}

/** Print usage and exit. */
function printMcpHelp(): void {
	console.log(`orbcode mcp — manage MCP servers

Usage:
  orbcode mcp add [options] <name> <command> [args...]    add a stdio server
  orbcode mcp add [options] --transport http <name> <url>  add an http server
  orbcode mcp add [options] --transport sse <name> <url>   add an sse server
  orbcode mcp remove <name>                                remove a server
  orbcode mcp list                                         list all servers

Options:
  -s, --scope <user|project|local>   config scope (default: project)
  -t, --transport <stdio|http|sse>   transport type (default: stdio)
  -e, --env KEY=value                environment variable (repeatable, stdio)
      --header KEY=value             HTTP header (repeatable, http/sse)
      --oauth                        enable OAuth for http/sse
      --oauth-scope <scope>          OAuth scope (implies --oauth)

Scopes:
  project   .mcp.json in the current directory (shared, checked into git)
  user      ~/.orbcode/settings.json (applies to all projects on this machine)
  local     .orbcode/settings.json (per-project, per-machine, not checked in)`)
}

/** Handle `orbcode mcp ...`. Returns the process exit code. */
export async function runMcpCommand(args: string[]): Promise<number> {
	const [subcommand, ...rest] = args

	switch (subcommand) {
		case "add":
			return runAdd(rest)
		case "remove":
		case "rm":
			return runRemove(rest)
		case "list":
		case "ls":
			return runList(rest)
		case "help":
		case "--help":
		case "-h":
			printMcpHelp()
			return 0
		default:
			console.error(`Unknown mcp subcommand: "${subcommand ?? ""}". Try: orbcode mcp help`)
			return 1
	}
}

/** Parse the flags shared by add (scope, transport, env, headers, oauth). */
function parseAddFlags(args: string[]): {
	scope: McpScope
	transport: (typeof VALID_TRANSPORTS)[number]
	env: Record<string, string>
	headers: Record<string, string>
	oauth: boolean | { scope: string }
	positional: string[]
} {
	let scope: McpScope = "project"
	let transport: (typeof VALID_TRANSPORTS)[number] = "stdio"
	const env: Record<string, string> = {}
	const headers: Record<string, string> = {}
	let oauth: boolean | { scope: string } = false
	const positional: string[] = []

	// Flags must come before the server name. Once we hit the first positional
	// (the server name), everything after it — including args that look like
	// flags (-y, -f, --foo) — becomes the server's command/args. This matches
	// Claude Code and lets stdio servers take their own flags.
	let sawPositional = false
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]!
		if (sawPositional) {
			// A "--" immediately after the server name is the separator between
			// orbcode's flags and the server's command (e.g. `add name -- npx`),
			// matching Claude Code's `claude mcp add <name> -- <command>`. Consume
			// it so it isn't mistaken for the command. A later "--" is kept as a
			// literal arg for the server command.
			if (arg === "--" && positional.length === 1) continue
			positional.push(arg)
			continue
		}
		if (arg === "-s" || arg === "--scope") {
			const value = args[++i]
			if (!value || !VALID_SCOPES.includes(value as McpScope)) {
				throw new Error(`Invalid scope "${value ?? ""}". Valid: ${VALID_SCOPES.join(", ")}`)
			}
			scope = value as McpScope
		} else if (arg === "-t" || arg === "--transport") {
			const value = args[++i]
			if (!value || !VALID_TRANSPORTS.includes(value as (typeof VALID_TRANSPORTS)[number])) {
				throw new Error(`Invalid transport "${value ?? ""}". Valid: ${VALID_TRANSPORTS.join(", ")}`)
			}
			transport = value as (typeof VALID_TRANSPORTS)[number]
		} else if (arg === "-e" || arg === "--env") {
			const value = args[++i]
			if (!value) throw new Error("Missing value for --env")
			const [k, v] = parseKeyValue(value)
			env[k] = v
		} else if (arg === "--header") {
			const value = args[++i]
			if (!value) throw new Error("Missing value for --header")
			const [k, v] = parseKeyValue(value)
			headers[k] = v
		} else if (arg === "--oauth") {
			oauth = true
		} else if (arg === "--oauth-scope") {
			const value = args[++i]
			if (!value) throw new Error("Missing value for --oauth-scope")
			oauth = { scope: value }
		} else if (arg === "--") {
			// Explicit separator: everything after is positional.
			sawPositional = true
		} else if (arg.startsWith("-") && arg.length > 1) {
			throw new Error(`Unknown flag: ${arg}. Put flags before the server name, or use -- to separate.`)
		} else {
			positional.push(arg)
			sawPositional = true
		}
	}

	return { scope, transport, env, headers, oauth, positional }
}

/** `orbcode mcp add` — build a server config from flags and write it. */
function runAdd(args: string[]): number {
	let parsed
	try {
		parsed = parseAddFlags(args)
	} catch (error) {
		console.error((error as Error).message)
		return 1
	}
	const { scope, transport, env, headers, oauth, positional } = parsed

	if (positional.length === 0) {
		console.error("Missing server name. Usage: orbcode mcp add <name> <command> [args...]")
		return 1
	}
	const [name, ...rest] = positional

	let config: McpServerConfig
	if (transport === "http" || transport === "sse") {
		if (rest.length === 0) {
			console.error(`Missing URL for ${transport} transport. Usage: orbcode mcp add -t ${transport} <name> <url>`)
			return 1
		}
		const url = rest[0]!
		const cfg: McpHttpServerConfig | McpSseServerConfig = { type: transport, url }
		if (Object.keys(headers).length > 0) cfg.headers = headers
		if (oauth !== false) cfg.oauth = oauth
		config = cfg
	} else {
		// stdio
		if (rest.length === 0) {
			console.error("Missing command for stdio transport. Usage: orbcode mcp add <name> <command> [args...]")
			return 1
		}
		const [command, ...cmdArgs] = rest
		const cfg: McpStdioServerConfig = { type: "stdio", command: command! }
		if (cmdArgs.length > 0) cfg.args = cmdArgs
		if (Object.keys(env).length > 0) cfg.env = env
		config = cfg
	}

	let detail: string
	if (transport === "http" || transport === "sse") {
		const cfg = config as McpHttpServerConfig | McpSseServerConfig
		detail = `${transport} ${cfg.url}`
	} else {
		const cfg = config as McpStdioServerConfig
		detail = `stdio ${cfg.command}${cfg.args?.length ? " " + cfg.args.join(" ") : ""}`
	}

	try {
		addMcpServer(process.cwd(), name!, config, scope)
	} catch (error) {
		console.error((error as Error).message)
		return 1
	}

	const filePath = configPathForScope(process.cwd(), scope)
	console.log(`Added ${transport === "http" || transport === "sse" ? transport.toUpperCase() : "stdio"} MCP server ${name}`)
	if (transport === "http" || transport === "sse") {
		console.log(`  URL: ${(config as McpHttpServerConfig).url}`)
	}
	console.log(`  Scope: ${scope}`)
	console.log(`  File modified: ${filePath}`)
	return 0
}

/** `orbcode mcp remove <name>` — remove from whichever scope it's in. */
function runRemove(args: string[]): number {
	if (args.length === 0) {
		console.error("Missing server name. Usage: orbcode mcp remove <name>")
		return 1
	}
	const name = args[0]!
	const scope = removeMcpServerAnyScope(process.cwd(), name)
	if (!scope) {
		console.error(`MCP server "${name}" not found in any scope.`)
		return 1
	}
	const filePath = configPathForScope(process.cwd(), scope)
	console.log(`Removed MCP server "${name}" from ${scope} scope.`)
	console.log(`  File modified: ${filePath}`)
	return 0
}

/** `orbcode mcp list` — print all configured servers with their scope + status. */
function runList(_args: string[]): number {
	const { servers } = loadMcpConfig(process.cwd())
	const names = Object.keys(servers).sort()
	if (names.length === 0) {
		console.log("No MCP servers configured.")
		console.log("Add one with: orbcode mcp add <name> <command> [args...]")
		return 0
	}
	for (const name of names) {
		const cfg = servers[name]!
		const scope = cfg.scope
		let detail: string
		if (cfg.type === "http" || cfg.type === "sse") {
			detail = `${cfg.type} ${cfg.url}`
		} else {
			// stdio (type undefined or "stdio")
			const cmd = cfg.command
			const args = cfg.args ?? []
			detail = `stdio ${cmd}${args.length ? " " + args.join(" ") : ""}`
		}
		console.log(`  ${name.padEnd(20)} ${scope.padEnd(8)} ${detail}`)
	}
	return 0
}
