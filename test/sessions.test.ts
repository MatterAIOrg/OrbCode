import assert from "node:assert/strict"
import test from "node:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { listSessions, saveSession, type SessionData } from "../src/core/sessions.js"

function save(id: string, cwd: string, updatedAt: string): void {
	saveSession({
		id,
		cwd,
		model: "m",
		title: id,
		createdAt: updatedAt,
		updatedAt,
		totalCost: 0,
		contextTokens: 0,
		todos: "",
		messages: [{ role: "user", content: "hi" }],
	} as SessionData)
}

test("listSessions filters by directory, or lists every directory when none is given", () => {
	process.env.MATTERAI_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-sessions-"))
	save("old-here", "/work/app", "2026-09-01T00:00:00.000Z")
	save("new-elsewhere", "/work/other", "2026-09-03T00:00:00.000Z")
	save("mid-here", "/work/app", "2026-09-02T00:00:00.000Z")

	assert.deepEqual(listSessions("/work/app").map((s) => s.id), ["mid-here", "old-here"])
	assert.deepEqual(listSessions().map((s) => s.id), ["new-elsewhere", "mid-here", "old-here"])
	assert.deepEqual(listSessions("/nowhere"), [])
})
