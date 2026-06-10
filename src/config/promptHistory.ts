import * as fs from "node:fs"
import * as path from "node:path"

import { getConfigDir } from "./settings.js"

const MAX_HISTORY = 200

function historyPath(): string {
	return path.join(getConfigDir(), "history.json")
}

/** Prompt history shared across sessions, oldest first (like shell history). */
export function loadPromptHistory(): string[] {
	try {
		const data = JSON.parse(fs.readFileSync(historyPath(), "utf8"))
		return Array.isArray(data) ? data.filter((e): e is string => typeof e === "string") : []
	} catch {
		return []
	}
}

export function appendPromptHistory(entry: string): void {
	try {
		const history = loadPromptHistory()
		// Like shells: skip consecutive duplicates.
		if (history[history.length - 1] === entry) return
		history.push(entry)
		fs.mkdirSync(getConfigDir(), { recursive: true })
		fs.writeFileSync(historyPath(), JSON.stringify(history.slice(-MAX_HISTORY), null, "\t") + "\n", {
			mode: 0o600,
		})
	} catch {
		// history is best-effort
	}
}
