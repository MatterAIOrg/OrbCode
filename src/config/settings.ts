import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DEFAULT_MODEL_ID, isValidAxonModel, registerCustomModels, type CustomModelConfig } from "../api/models.js"

export interface OrbCodeSettings {
	/** login token, written by `orbcode login` (config.json only) */
	token?: string
	model: string
	organizationId?: string
	autoApproveEdits: boolean
	autoApproveSafeCommands: boolean

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
}

const DEFAULTS: OrbCodeSettings = {
	model: DEFAULT_MODEL_ID,
	autoApproveEdits: false,
	autoApproveSafeCommands: false,
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
] as const

export function getConfigDir(): string {
	return process.env.ORBCODE_CONFIG_DIR || path.join(os.homedir(), ".orbcode")
}

function getConfigPath(): string {
	return path.join(getConfigDir(), "config.json")
}

/** settings.json locations, lowest precedence first: user, then project. */
export function getSettingsPaths(cwd = process.cwd()): string[] {
	return [path.join(getConfigDir(), "settings.json"), path.join(cwd, ".orbcode", "settings.json")]
}

function readJson(filePath: string): Record<string, unknown> | undefined {
	try {
		return JSON.parse(fs.readFileSync(filePath, "utf8"))
	} catch {
		return undefined
	}
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
	const customModels: CustomModelConfig[] = []
	for (const settingsPath of getSettingsPaths()) {
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
	}
	if (customModels.length > 0) {
		settings.customModels = customModels
		registerCustomModels(customModels)
	}

	// env block from settings.json applies to this process.
	if (settings.env && typeof settings.env === "object") {
		for (const [key, value] of Object.entries(settings.env)) {
			if (typeof value === "string") process.env[key] = value
		}
	}

	// Environment variables take precedence over all files.
	if (process.env.ORBCODE_BASE_URL) settings.baseUrl = process.env.ORBCODE_BASE_URL
	if (process.env.ORBCODE_API_KEY) settings.apiKey = process.env.ORBCODE_API_KEY
	if (process.env.ORBCODE_MODEL) settings.model = process.env.ORBCODE_MODEL

	if (!isValidAxonModel(settings.model)) {
		settings.model = DEFAULT_MODEL_ID
	}
	return settings
}

/**
 * Effective credential: ORBCODE_TOKEN env > apiKey (settings.json / env) >
 * stored login token.
 */
export function getAuthToken(settings: OrbCodeSettings): string | undefined {
	return process.env.ORBCODE_TOKEN || settings.apiKey || settings.token
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
	}
	fs.writeFileSync(getConfigPath(), JSON.stringify(toPersist, null, "\t") + "\n", { mode: 0o600 })
}
