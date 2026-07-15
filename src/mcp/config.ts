import * as fs from "node:fs"
import * as path from "node:path"

import { getConfigDir } from "../config/settings.js"
import { installedPluginDirs } from "../plugins/manager.js"
import type {
	McpHttpServerConfig,
	McpJsonConfig,
	McpOAuthConfig,
	McpScope,
	McpServerConfig,
	McpSseServerConfig,
	McpStdioServerConfig,
	ScopedMcpServerConfig,
} from "./types.js"

/**
 * MCP server configuration loader.
 *
 * Resolution order (lowest precedence first), mirroring Claude Code:
 *   1. User scope: `~/.orbcode/settings.json` -> `mcpServers`
 *   2. Project scope: `.mcp.json` in the cwd and every parent directory
 *      (closer-to-cwd wins on name collisions)
 *   3. Local scope: `.orbcode/settings.json` -> `mcpServers` (highest precedence)
 *
 * `.mcp.json` is the shared, check-into-git project file (Claude Code compatible).
 * The `mcpServers` block in settings.json is the per-user/per-machine override.
 */

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch {
		return undefined
	}
}

/** Expand ${VAR} and $VAR references in a string using process.env. */
function expandEnv(value: string, overrides: Record<string, string> = {}): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, bare) => {
		const name = braced ?? bare
		return overrides[name] ?? process.env[name] ?? ""
	})
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Normalize an `oauth` config value: boolean, or an object with grant/scope. */
function normalizeOAuth(raw: unknown): McpOAuthConfig | undefined {
	if (raw === true) return true
	if (typeof raw === "string" && raw === "true") return true
	if (!isPlainObject(raw)) return undefined
	if (raw.grantType === "client_credentials") {
		if (typeof raw.clientId !== "string" || typeof raw.clientSecret !== "string") return undefined
		return {
			grantType: "client_credentials",
			clientId: String(raw.clientId),
			clientSecret: String(raw.clientSecret),
			scope: typeof raw.scope === "string" ? raw.scope : undefined,
		}
	}
	if (raw.grantType === "private_key_jwt") {
		if (typeof raw.clientId !== "string") return undefined
		if (typeof raw.algorithm !== "string") return undefined
		const privateKey = typeof raw.privateKey === "string" ? raw.privateKey : isPlainObject(raw.privateKey) ? raw.privateKey : undefined
		if (privateKey === undefined) return undefined
		return {
			grantType: "private_key_jwt",
			clientId: String(raw.clientId),
			privateKey,
			algorithm: String(raw.algorithm),
			scope: typeof raw.scope === "string" ? raw.scope : undefined,
		}
	}
	// Plain object (no grantType) → interactive auth-code flow with optional scope.
	return { scope: typeof raw.scope === "string" ? raw.scope : undefined }
}

/** Validate + normalize a single server config object from disk. */
function normalizeServerConfig(raw: unknown, variables: Record<string, string> = {}): McpServerConfig | undefined {
	if (!isPlainObject(raw)) return undefined
	const type = typeof raw.type === "string" ? raw.type : "stdio"

	if (type === "stdio") {
		if (typeof raw.command !== "string" || !raw.command.trim()) return undefined
		const config: McpStdioServerConfig = { type: "stdio", command: expandEnv(raw.command, variables) }
		if (Array.isArray(raw.args)) {
			config.args = raw.args.map((a) => expandEnv(String(a), variables))
		}
		if (isPlainObject(raw.env)) {
			const env: Record<string, string> = {}
			for (const [k, v] of Object.entries(raw.env)) {
				if (typeof v === "string") env[k] = expandEnv(v, variables)
			}
			config.env = env
		}
		if (typeof raw.cwd === "string") config.cwd = expandEnv(raw.cwd, variables)
		return config
	}

	if (type === "http" || type === "sse") {
		if (typeof raw.url !== "string" || !raw.url.trim()) return undefined
		const config: McpHttpServerConfig | McpSseServerConfig = {
			type,
			url: expandEnv(raw.url, variables),
		} as McpHttpServerConfig | McpSseServerConfig
		if (isPlainObject(raw.headers)) {
			const headers: Record<string, string> = {}
			for (const [k, v] of Object.entries(raw.headers)) {
				if (typeof v === "string") headers[k] = expandEnv(v, variables)
			}
			;(config as McpHttpServerConfig).headers = headers
		}
		const oauth = normalizeOAuth(raw.oauth)
		if (oauth !== undefined) (config as McpHttpServerConfig).oauth = oauth
		return config
	}

	return undefined
}

/** Validate + normalize a whole `mcpServers` record. */
function normalizeServers(
	raw: unknown,
	variables: Record<string, string> = {},
): Record<string, McpServerConfig> {
	if (!isPlainObject(raw)) return {}
	const servers: Record<string, McpServerConfig> = {}
	for (const [name, cfg] of Object.entries(raw)) {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) continue
		const normalized = normalizeServerConfig(cfg, variables)
		if (normalized) servers[name] = normalized
	}
	return servers
}

/** Read `mcpServers` from a settings.json file (user or local scope). */
function readSettingsServers(filePath: string): Record<string, McpServerConfig> {
	const json = readJson(filePath)
	if (!json) return {}
	return normalizeServers(json.mcpServers)
}

/** Read a `.mcp.json` file (project scope). */
function readMcpJson(filePath: string): Record<string, McpServerConfig> {
	const json = readJson(filePath)
	if (!json || !isPlainObject(json.mcpServers)) return {}
	return normalizeServers(json.mcpServers)
}

function pluginMcpServers(pluginDir: string): Record<string, McpServerConfig> {
	const metadata = readJson(path.join(pluginDir, ".orb-plugin.json"))
	const manifest = readJson(path.join(pluginDir, ".claude-plugin", "plugin.json"))
	const variables = {
		CLAUDE_PLUGIN_ROOT: pluginDir,
		ORB_PLUGIN_ROOT: pluginDir,
	}
	const merged: Record<string, McpServerConfig> = {}
	const mergeCandidate = (candidate: unknown): void => {
		let raw = candidate
		if (typeof candidate === "string") {
			const target = path.resolve(pluginDir, candidate)
			const root = path.resolve(pluginDir)
			if (target !== root && !target.startsWith(root + path.sep)) return
			const json = readJson(target)
			raw = json?.mcpServers ?? json
		}
		if (isPlainObject(raw) && isPlainObject(raw.mcpServers)) raw = raw.mcpServers
		Object.assign(merged, normalizeServers(raw, variables))
	}

	const defaultConfig = readJson(path.join(pluginDir, ".mcp.json"))
	if (defaultConfig) mergeCandidate(defaultConfig)
	mergeCandidate(manifest?.mcpServers)
	mergeCandidate(metadata?.mcpServers)
	return merged
}

/** Walk from cwd up to the filesystem root, collecting directories (root last). */
function ancestorDirs(cwd: string): string[] {
	const dirs: string[] = []
	let current = path.resolve(cwd)
	const root = path.parse(current).root
	while (current !== root) {
		dirs.push(current)
		const parent = path.dirname(current)
		if (parent === current) break
		current = parent
	}
	return dirs
}

export interface ResolvedMcpConfig {
	/** server name -> scoped config, with local overriding project overriding user. */
	servers: Record<string, ScopedMcpServerConfig>
}

/**
 * Load and merge MCP server configs from all scopes. Closer-to-cwd and
 * higher-precedence scopes override earlier ones on name collisions.
 */
export function loadMcpConfig(cwd = process.cwd()): ResolvedMcpConfig {
	const servers: Record<string, ScopedMcpServerConfig> = {}

	// 1. User scope (~/.orbcode/settings.json -> mcpServers)
	const userServers = readSettingsServers(path.join(getConfigDir(), "settings.json"))
	for (const [name, cfg] of Object.entries(userServers)) {
		servers[name] = { ...cfg, scope: "user" as McpScope }
	}

	// Installed plugins contribute project-scoped MCP servers. Namespace them
	// like Claude Code so plugins cannot collide with each other or user config.
	for (const pluginDir of installedPluginDirs(cwd)) {
		const pluginName = path.basename(pluginDir).replace(/[^A-Za-z0-9_-]/g, "_")
		for (const [name, cfg] of Object.entries(pluginMcpServers(pluginDir))) {
			servers[`plugin_${pluginName}_${name}`] = { ...cfg, scope: "project" as McpScope }
		}
	}

	// 2. Project scope (.mcp.json, root -> cwd so cwd wins)
	for (const dir of ancestorDirs(cwd).reverse()) {
		const projectServers = readMcpJson(path.join(dir, ".mcp.json"))
		for (const [name, cfg] of Object.entries(projectServers)) {
			servers[name] = { ...cfg, scope: "project" as McpScope }
		}
	}

	// 3. Local scope (.orbcode/settings.json -> mcpServers) — highest precedence
	const localServers = readSettingsServers(path.join(cwd, ".orbcode", "settings.json"))
	for (const [name, cfg] of Object.entries(localServers)) {
		servers[name] = { ...cfg, scope: "local" as McpScope }
	}

	return { servers }
}

/** Write a `.mcp.json` file in the cwd (project scope). */
export function writeProjectMcpJson(cwd: string, servers: Record<string, McpServerConfig>): void {
	const config: McpJsonConfig = { mcpServers: servers }
	fs.writeFileSync(path.join(cwd, ".mcp.json"), JSON.stringify(config, null, "\t") + "\n")
}

/** Read just the project-scope `.mcp.json` from the cwd (no parent walk). */
export function readProjectMcpJson(cwd: string): Record<string, McpServerConfig> {
	return readMcpJson(path.join(cwd, ".mcp.json"))
}

/** Read a settings.json file, returning the full object (not just mcpServers). */
function readFullSettings(filePath: string): Record<string, unknown> {
	return readJson(filePath) ?? {}
}

/** Write a settings.json file, preserving existing keys. */
function writeFullSettings(filePath: string, data: Record<string, unknown>): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true })
	fs.writeFileSync(filePath, JSON.stringify(data, null, "\t") + "\n", { mode: 0o600 })
}

/** Path to the settings file for a given scope. */
function settingsPathForScope(cwd: string, scope: McpScope): string {
	if (scope === "user") return path.join(getConfigDir(), "settings.json")
	return path.join(cwd, ".orbcode", "settings.json")
}

/** Path to the config file for a given scope (`.mcp.json` for project,
 *  settings.json for user/local). */
export function configPathForScope(cwd: string, scope: McpScope): string {
	if (scope === "project") return path.join(cwd, ".mcp.json")
	return settingsPathForScope(cwd, scope)
}

/** Add (or overwrite) a server in the given scope's config file. */
export function addMcpServer(cwd: string, name: string, config: McpServerConfig, scope: McpScope): void {
	if (!/^[A-Za-z0-9_-]+$/.test(name)) {
		throw new Error(`Invalid server name "${name}". Use only letters, numbers, hyphens, and underscores.`)
	}
	if (scope === "project") {
		const existing = readProjectMcpJson(cwd)
		existing[name] = config
		writeProjectMcpJson(cwd, existing)
	} else {
		const filePath = settingsPathForScope(cwd, scope)
		const settings = readFullSettings(filePath)
		const servers = normalizeServers(settings.mcpServers)
		servers[name] = config
		settings.mcpServers = servers
		writeFullSettings(filePath, settings)
	}
}

/** Remove a server from the given scope's config file. Returns true if it
 *  existed and was removed, false if it wasn't found. */
export function removeMcpServer(cwd: string, name: string, scope: McpScope): boolean {
	if (scope === "project") {
		const existing = readProjectMcpJson(cwd)
		if (!(name in existing)) return false
		delete existing[name]
		writeProjectMcpJson(cwd, existing)
		return true
	}
	const filePath = settingsPathForScope(cwd, scope)
	const settings = readFullSettings(filePath)
	const servers = normalizeServers(settings.mcpServers)
	if (!(name in servers)) return false
	delete servers[name]
	settings.mcpServers = servers
	writeFullSettings(filePath, settings)
	return true
}

/** Find which scope a server name lives in (highest-precedence scope wins).
 *  Returns undefined if the name isn't configured anywhere. */
export function findServerScope(cwd: string, name: string): McpScope | undefined {
	const { servers } = loadMcpConfig(cwd)
	return servers[name]?.scope
}

/** Remove a server from whichever scope it's configured in. Returns the scope
 *  it was removed from, or undefined if not found. */
export function removeMcpServerAnyScope(cwd: string, name: string): McpScope | undefined {
	const scope = findServerScope(cwd, name)
	if (!scope) return undefined
	removeMcpServer(cwd, name, scope)
	return scope
}
