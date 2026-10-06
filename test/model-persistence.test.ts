import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { DEFAULT_MODEL_ID, getModel, loadCachedModelCatalog } from "../src/api/models.js"
import { getModelEffort, loadSettings } from "../src/config/settings.js"

// Settings and the catalog cache read the config dir lazily.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-persist-"))
process.env.MATTERAI_CONFIG_DIR = configDir

const CATALOG_ONLY = "deepseek/deepseek-v4.1-flash"

fs.writeFileSync(
	path.join(configDir, "config.json"),
	JSON.stringify({ model: CATALOG_ONLY, theme: "dark", modelEfforts: { [CATALOG_ONLY]: "high" } }),
)
fs.writeFileSync(
	path.join(configDir, "models-cache.json"),
	JSON.stringify({
		data: [
			{
				id: CATALOG_ONLY,
				name: "DeepSeek V4.1 Flash",
				context_length: 232000,
				pricing: { prompt: "0.0000003", completion: "0.0000012" },
				costMultiplier: 1,
			},
		],
	}),
)

test("a saved catalog-only model and its effort survive a restart", () => {
	// Without the cached catalog (the old startup), the saved model reads as
	// unknown and falls back to the default — losing its effort too.
	assert.equal(loadSettings().model, DEFAULT_MODEL_ID)

	// Startup now registers the cached catalog before reading settings.
	loadCachedModelCatalog()
	const settings = loadSettings()
	assert.equal(settings.model, CATALOG_ONLY)
	assert.equal(getModelEffort(settings, getModel(settings.model)), "high")
})

test("a missing or corrupt cache is ignored", () => {
	fs.writeFileSync(path.join(configDir, "models-cache.json"), "{not json")
	assert.doesNotThrow(() => loadCachedModelCatalog())
	fs.rmSync(path.join(configDir, "models-cache.json"))
	assert.doesNotThrow(() => loadCachedModelCatalog())
})
