import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DEFAULT_MODEL_ID, isValidAxonModel, registerCustomModels, type CustomModelConfig } from "../api/models.js"
import { isHookEvent, type HookMatcher, type HooksConfig } from "../core/hooks.js"
import type { McpServerConfig } from "../mcp/types.js"

export type OrbCodeThemeMode = "dark" | "light"

export interface OrbCodeSettings {
	/** login token, written by `orbcode login` (config.json only) */
	token?: string
	model: string
	organizationId?: string
	autoApproveEdits: boolean
	autoApproveSafeCommands: boolean
	/** OrbCode-owned TUI palette; terminal theme detection never overrides it. */
	theme: OrbCodeThemeMode

	// The fields below come from settings.json files (and env vars) and are
	// never persisted back to config.json.
	/** custom OpenAI-compatible gateway base URL */
	baseUrl?: string
	/** auth key used instead of the stored login token */
	apiKey?: string
	/** extra models to register alongside the built-in Axon models */
	customModels?: CustomModelConfig[]
	/** environment variables applied to this process on startup */
	env?: Record<string, string>
	/** lifecycle hooks (Claude-Code style); merged across all settings.json files */
	hooks?: HooksConfig
	/** MCP servers defined in settings.json (user/local scope). Project-scope
	 *  servers live in `.mcp.json` and are loaded by the MCP config layer. */
	mcpServers?: Record<string, McpServerConfig>
	/** project-scope MCP server names the user has approved to connect. */
	enabledMcpServers?: string[]
	/** MCP server names the user has explicitly disabled. */
	disabledMcpServers?: string[]
}

const DEFAULTS: OrbCodeSettings = {
	model: DEFAULT_MODEL_ID,
	autoApproveEdits: false,
	autoApproveSafeCommands: false,
	theme: "dark",
}

/** Keys that settings.json files may set, in increasing precedence order. */
const SETTINGS_KEYS = [
	"model",
	"organizationId",
	"autoApproveEdits",
	"autoApproveSafeCommands",
	"baseUrl",
	"apiKey",
	"env",
	"enabledMcpServers",
	"disabledMcpServers",
] as const

export function getConfigDir(): string {
	return process.env.MATTERAI_CONFIG_DIR || path.join(os.homedir(), ".orbcode")
}

function getConfigPath(): string {
	return path.join(getConfigDir(), "config.json")
}

/** settings.json locations, lowest precedence first: user, then project. */
export function getSettingsPaths(cwd = process.cwd()): string[] {
	return [path.join(getConfigDir(), "settings.json"), path.join(cwd, ".orbcode", "settings.json")]
}

/** Concatenate a settings file's `hooks` block into the accumulator, keeping
 *  only known events and well-formed matcher arrays. */
function mergeHooksInto(target: HooksConfig, raw: unknown): void {
	if (!raw || typeof raw !== "object") return
	for (const [event, matchers] of Object.entries(raw as Record<string, unknown>)) {
		if (!isHookEvent(event)) continue
		if (!Array.isArray(matchers)) continue
		;(target[event] ??= []).push(...(matchers as HookMatcher[]))
	}
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch {
		return undefined
	}
}

// --- Project-hook trust ---------------------------------------------------
// User-level hooks (~/.orbcode/settings.json) are written by the user and are
// always trusted. Project-level hooks (<cwd>/.orbcode/settings.json) ship
// inside a repo and could come from anyone, so they run arbitrary shell
// commands only after the user explicitly trusts them. Trust is keyed by
// project path + a hash of the hooks, so changing the hooks re-prompts.

function getProjectSettingsPath(cwd: string): string {
	return path.join(cwd, ".orbcode", "settings.json")
}

function getTrustStorePath(): string {
	return path.join(getConfigDir(), "hook-trust.json")
}

/** Normalized project hooks (known events only), or undefined if none. */
function readProjectHooks(cwd: string): HooksConfig | undefined {
	const merged: HooksConfig = {}
	mergeHooksInto(merged, readJson(getProjectSettingsPath(cwd))?.hooks)
	return Object.keys(merged).length > 0 ? merged : undefined
}

function hashHooks(hooks: HooksConfig): string {
	return crypto.createHash("sha256").update(JSON.stringify(hooks)).digest("hex").slice(0, 16)
}

function isProjectHooksTrusted(cwd: string, hash: string): boolean {
	// Escape hatch for CI / non-interactive automation. Only honored when
	// stdin is not a TTY (so a stray export in a shell rc file can't silently
	// disable the trust gate for interactive sessions). A non-TTY check keeps
	// the gate meaningful in the TUI while still letting CI opt in.
	if (process.env.MATTERAI_TRUST_PROJECT_HOOKS === "1" && !process.stdin.isTTY) return true
	const store = readJson(getTrustStorePath())
	return Boolean(store && store[cwd] === hash)
}

/** Persist trust for the current project's hooks (call after the user agrees). */
export function trustProjectHooks(cwd = process.cwd()): void {
	const hooks = readProjectHooks(cwd)
	if (!hooks) return
	const store = (readJson(getTrustStorePath()) as Record<string, string> | undefined) ?? {}
	store[cwd] = hashHooks(hooks)
	try {
		fs.mkdirSync(getConfigDir(), { recursive: true })
		fs.writeFileSync(getTrustStorePath(), JSON.stringify(store, null, "\t") + "\n", { mode: 0o600 })
	} catch {
		// best-effort; if it can't be persisted the user will simply be re-prompted
	}
}

/**
 * If this project defines hooks that are not yet trusted, return the list of
 * shell commands awaiting approval; otherwise null (no project hooks, or already
 * trusted). The TUI uses this to gate project hooks behind a trust prompt.
 */
export function getPendingProjectHooks(cwd = process.cwd()): { commands: string[] } | null {
	const hooks = readProjectHooks(cwd)
	if (!hooks) return null
	if (isProjectHooksTrusted(cwd, hashHooks(hooks))) return null
	const commands: string[] = []
	for (const matchers of Object.values(hooks)) {
		for (const matcher of matchers ?? []) {
			for (const hook of matcher.hooks ?? []) {
				if (hook?.command) commands.push(hook.command)
			}
		}
	}
	return { commands }
}

/** Make sure ~/.orbcode/settings.json exists (empty JSON) so users can find it. */
function ensureUserSettingsFile(): void {
	try {
		const settingsPath = path.join(getConfigDir(), "settings.json")
		if (!fs.existsSync(settingsPath)) {
			fs.mkdirSync(getConfigDir(), { recursive: true })
			fs.writeFileSync(settingsPath, "{}\n", { mode: 0o600 })
		}
	} catch {
		// best-effort; loadSettings works without the file
	}
}

export function loadSettings(): OrbCodeSettings {
	ensureUserSettingsFile()
	const settings: OrbCodeSettings = { ...DEFAULTS, ...readJson(getConfigPath()) }

	// Layer settings.json files on top (user config dir, then project).
	const cwd = process.cwd()
	const customModels: CustomModelConfig[] = []
	for (const settingsPath of getSettingsPaths(cwd)) {
		const fileSettings = readJson(settingsPath)
		if (!fileSettings) continue
		for (const key of SETTINGS_KEYS) {
			if (fileSettings[key] !== undefined) {
				;(settings as unknown as Record<string, unknown>)[key] = fileSettings[key]
			}
		}
		if (Array.isArray(fileSettings.customModels)) {
			customModels.push(...(fileSettings.customModels as CustomModelConfig[]))
		}
		// MCP servers: merge across scopes (local overrides project overrides
		// user on name collisions). The MCP config layer also reads .mcp.json;
		// settings.json mcpServers are the per-user/per-machine override path.
		if (fileSettings.mcpServers && typeof fileSettings.mcpServers === "object") {
			settings.mcpServers = { ...(settings.mcpServers ?? {}), ...(fileSettings.mcpServers as Record<string, McpServerConfig>) }
		}
	}
	if (customModels.length > 0) {
		settings.customModels = customModels
		registerCustomModels(customModels)
	}

	// Hooks: user-level hooks always apply; project-level hooks run alongside
	// them but only once trusted (they execute arbitrary shell commands). The
	// two sets concatenate, so a trusted project adds to — never clobbers — your
	// global hooks.
	const mergedHooks: HooksConfig = {}
	mergeHooksInto(mergedHooks, readJson(path.join(getConfigDir(), "settings.json"))?.hooks)
	const projectHooks = readProjectHooks(cwd)
	if (projectHooks && isProjectHooksTrusted(cwd, hashHooks(projectHooks))) {
		for (const [event, matchers] of Object.entries(projectHooks)) {
			;(mergedHooks[event as keyof HooksConfig] ??= []).push(...(matchers as HookMatcher[]))
		}
	}
	if (Object.keys(mergedHooks).length > 0) {
		settings.hooks = mergedHooks
	}

	// env block from settings.json applies to this process.
	if (settings.env && typeof settings.env === "object") {
		for (const [key, value] of Object.entries(settings.env)) {
			if (typeof value === "string") process.env[key] = value
		}
	}

	// Environment variables take precedence over all files.
	if (process.env.MATTERAI_BASE_URL) settings.baseUrl = process.env.MATTERAI_BASE_URL
	if (process.env.MATTERAI_API_KEY) settings.apiKey = process.env.MATTERAI_API_KEY
	if (process.env.MATTERAI_MODEL) settings.model = process.env.MATTERAI_MODEL

	if (!isValidAxonModel(settings.model)) {
		settings.model = DEFAULT_MODEL_ID
	}
	if (settings.theme !== "dark" && settings.theme !== "light") {
		settings.theme = DEFAULTS.theme
	}
	return settings
}

/**
 * Effective credential: MATTERAI_TOKEN env > apiKey (settings.json / env) >
 * stored login token.
 */
export function getAuthToken(settings: OrbCodeSettings): string | undefined {
	return process.env.MATTERAI_TOKEN || settings.apiKey || settings.token
}

/** Persist app state to config.json. settings.json-only fields are skipped. */
export function saveSettings(settings: OrbCodeSettings): void {
	const dir = getConfigDir()
	fs.mkdirSync(dir, { recursive: true })
	const toPersist = {
		token: settings.token,
		model: settings.model,
		organizationId: settings.organizationId,
		autoApproveEdits: settings.autoApproveEdits,
		autoApproveSafeCommands: settings.autoApproveSafeCommands,
		theme: settings.theme,
	}
	fs.writeFileSync(getConfigPath(), JSON.stringify(toPersist, null, "\t") + "\n", { mode: 0o600 })
}

/**
 * Persist the enabled/disabled MCP server lists to the local project
 * settings.json (`.orbcode/settings.json`). These are per-project approval
 * decisions, so they live in the local scope, not in config.json.
 */
export function saveMcpApproval(
	cwd: string,
	enabled: string[],
	disabled: string[],
): void {
	const settingsPath = path.join(cwd, ".orbcode", "settings.json")
	let existing: Record<string, unknown> = {}
	try {
		existing = JSON.parse(fs.readFileSync(settingsPath, "utf8"))
	} catch {
		// file may not exist yet
	}
	existing.enabledMcpServers = [...new Set(enabled)]
	existing.disabledMcpServers = [...new Set(disabled)]
	fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
	fs.writeFileSync(settingsPath, JSON.stringify(existing, null, "\t") + "\n", { mode: 0o600 })
}
