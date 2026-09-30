import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DEFAULT_MODEL_ID } from "../src/api/models.js"
import { loadSettings, saveSettings } from "../src/config/settings.js"

function isolate(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-settings-"))
	process.env.MATTERAI_CONFIG_DIR = dir
	delete process.env.MATTERAI_MODEL
	process.chdir(dir)
	return dir
}

test("a fresh install has no explicit model", () => {
	isolate()
	const settings = loadSettings()
	assert.equal(settings.model, DEFAULT_MODEL_ID)
	assert.ok(!settings.modelExplicit)
})

test("explicitly picking the static default model survives a save/load round-trip", () => {
	isolate()
	saveSettings({ ...loadSettings(), model: DEFAULT_MODEL_ID, modelExplicit: true })
	const settings = loadSettings()
	assert.equal(settings.model, DEFAULT_MODEL_ID)
	assert.equal(settings.modelExplicit, true)
})

test("an automatic switch is not persisted as explicit", () => {
	const dir = isolate()
	saveSettings({ ...loadSettings(), model: DEFAULT_MODEL_ID, modelExplicit: false })
	assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).modelExplicit, undefined)
	assert.ok(!loadSettings().modelExplicit)
})

test("MATTERAI_MODEL pins the model", () => {
	isolate()
	process.env.MATTERAI_MODEL = DEFAULT_MODEL_ID
	try {
		assert.equal(loadSettings().modelExplicit, true)
	} finally {
		delete process.env.MATTERAI_MODEL
	}
})

test("a model set in settings.json is explicit", () => {
	const dir = isolate()
	fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ model: DEFAULT_MODEL_ID }))
	assert.equal(loadSettings().modelExplicit, true)
})

test("an unknown stored model falls back to the default and is not explicit", () => {
	isolate()
	saveSettings({ ...loadSettings(), model: "no-such-model", modelExplicit: true })
	const settings = loadSettings()
	assert.equal(settings.model, DEFAULT_MODEL_ID)
	assert.ok(!settings.modelExplicit)
})
