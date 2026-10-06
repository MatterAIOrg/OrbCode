import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { AxonClient } from "../src/api/client.js"
import { X_REASONING_EFFORT } from "../src/api/headers.js"
import { getModel, getModelEffortLevels, type AxonModel } from "../src/api/models.js"
import {
	getModelEffort,
	loadModelEfforts,
	loadSettings,
	saveSettings,
	setSessionModelEffort,
} from "../src/config/settings.js"

// Settings read the config dir lazily, so this isolates every call below.
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-effort-"))
process.env.MATTERAI_CONFIG_DIR = configDir

function model(id: string, overrides: Partial<AxonModel> = {}): AxonModel {
	return {
		id,
		name: id,
		description: "",
		contextWindow: 232_000,
		maxOutputTokens: 64_000,
		supportsImages: true,
		inputPrice: 0,
		outputPrice: 0,
		free: false,
		...overrides,
	}
}

test("the four gateway models have the selector before the catalog loads; others don't", () => {
	for (const id of ["zai/glm-5.3", "zai/glm-5.3-flash", "gemini-3.8-flash", "deepseek/deepseek-v4.1-flash"]) {
		assert.deepEqual(getModelEffortLevels(model(id)), ["low", "medium", "high", "max"])
	}
	assert.deepEqual(getModelEffortLevels(model("gpt-5.6-sol")), [])
	// Own-provider models use their own `effort` setting instead.
	assert.deepEqual(getModelEffortLevels(model("zai/glm-5.3", { provider: "anthropic" })), [])
})

test("the catalog's reasoning_efforts list wins over the built-in one", () => {
	assert.deepEqual(getModelEffortLevels(model("gpt-5.6-sol", { reasoningEfforts: ["low", "high"] })), ["low", "high"])
	assert.deepEqual(getModelEffortLevels(model("zai/glm-5.3", { reasoningEfforts: [] })), [])
})

test("effort defaults to medium and follows the saved pick", () => {
	const glm = model("zai/glm-5.3")
	assert.equal(getModelEffort({}, glm), "medium")
	assert.equal(getModelEffort({ modelEfforts: { "zai/glm-5.3": "max" } }, glm), "max")
	// A pick the model no longer supports falls back to the default.
	assert.equal(
		getModelEffort({ modelEfforts: { "zai/glm-5.3": "max" } }, model("zai/glm-5.3", { reasoningEfforts: ["low", "medium"] })),
		"medium",
	)
	assert.equal(getModelEffort({ modelEfforts: { "gpt-5.6-sol": "max" } }, model("gpt-5.6-sol")), undefined)
})

test("efforts persist in config.json, per model, and are readable without a full settings load", () => {
	const settings = loadSettings()
	saveSettings({ ...settings, modelEfforts: { "zai/glm-5.3": "high", "gemini-3.8-flash": "low" } })
	assert.deepEqual(loadModelEfforts(), { modelEfforts: { "zai/glm-5.3": "high", "gemini-3.8-flash": "low" } })
	assert.deepEqual(loadSettings().modelEfforts, { "zai/glm-5.3": "high", "gemini-3.8-flash": "low" })

	// Hand-edited junk is ignored.
	const configPath = path.join(configDir, "config.json")
	const raw = JSON.parse(fs.readFileSync(configPath, "utf8"))
	raw.modelEfforts["zai/glm-5.3-flash"] = "ultra"
	fs.writeFileSync(configPath, JSON.stringify(raw))
	assert.equal(loadModelEfforts().modelEfforts?.["zai/glm-5.3-flash"], undefined)
	assert.equal(loadSettings().modelEfforts?.["zai/glm-5.3-flash"], undefined)
})

test("every request sends the effort currently saved on this machine", () => {
	const headersFor = (modelId: string) => {
		const client = new AxonClient({ token: "t", modelId, taskId: "task" })
		return (client as unknown as { requestHeaders(m: AxonModel): Record<string, string> }).requestHeaders(
			getModel(modelId),
		)
	}
	saveSettings({ ...loadSettings(), modelEfforts: {} })
	assert.equal(headersFor("zai/glm-5.3-flash")[X_REASONING_EFFORT], "medium")

	// Another chat (process) saves a new pick: the next request picks it up.
	saveSettings({ ...loadSettings(), modelEfforts: { "zai/glm-5.3-flash": "max" } })
	assert.equal(headersFor("zai/glm-5.3-flash")[X_REASONING_EFFORT], "max")

	// Models without the selector send no effort header.
	assert.equal(headersFor("gpt-5.6-sol")[X_REASONING_EFFORT], undefined)
})

test("a session-only pick overrides the saved one in this process without being saved", () => {
	saveSettings({ ...loadSettings(), modelEfforts: { "zai/glm-5.3": "high" } })
	setSessionModelEffort("zai/glm-5.3", "low")
	try {
		assert.equal(loadModelEfforts().modelEfforts?.["zai/glm-5.3"], "low")
		assert.equal(loadSettings().modelEfforts?.["zai/glm-5.3"], "high")
		const configPath = path.join(configDir, "config.json")
		assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).modelEfforts["zai/glm-5.3"], "high")
	} finally {
		setSessionModelEffort("zai/glm-5.3", undefined)
	}
	assert.equal(loadModelEfforts().modelEfforts?.["zai/glm-5.3"], "high")
})
