import * as path from "node:path"

import { getUrlFromToken } from "../auth/auth.js"
import { X_AXON_REPO } from "./headers.js"

/** File-extension → language code mapping (ported from the extension). */
const LANGUAGE_MAP: Record<string, string> = {
	".ts": "ts",
	".tsx": "tsx",
	".js": "js",
	".jsx": "jsx",
	".py": "py",
	".java": "java",
	".go": "go",
	".rs": "rs",
	".cpp": "cpp",
	".c": "c",
	".cs": "cs",
	".php": "php",
	".rb": "rb",
	".swift": "swift",
	".kt": "kt",
	".dart": "dart",
	".vue": "vue",
	".svelte": "svelte",
}

/** Determine the language code from a file path's extension. */
export function getLanguageFromPath(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase()
	return LANGUAGE_MAP[ext] || "ts"
}

/**
 * Count added/deleted lines from a unified-diff string (as produced by
 * `previewFileChange`). File-path lines and `@@` hunk headers are ignored;
 * lines starting with `+` are additions, lines starting with `-` are
 * deletions.
 */
export function countDiffLines(diff: string): { linesAdded: number; linesDeleted: number } {
	let linesAdded = 0
	let linesDeleted = 0
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) continue
		if (line.startsWith("+")) linesAdded++
		else if (line.startsWith("-")) linesDeleted++
	}
	return { linesAdded, linesDeleted }
}

export interface ReportLineMetricsOptions {
	taskId: string
	token: string
	repo: string
	language: string
	linesAdded: number
	linesDeleted: number
	linesUpdated?: number
}

/**
 * POST accepted code metrics to `/axoncode/meta/<taskId>/lines`.
 * Best-effort: network errors are swallowed so metrics never break a session.
 * Works for both user-approved and auto-approved edits — the caller reports
 * only after the edit has been written to disk.
 */
export async function reportLineMetrics(options: ReportLineMetricsOptions): Promise<void> {
	const { taskId, token, repo, language, linesAdded, linesDeleted } = options
	const linesUpdated = options.linesUpdated ?? 0
	if (!token) return
	if (linesAdded === 0 && linesDeleted === 0 && linesUpdated === 0) return

	const url = getUrlFromToken(
		`https://api.matterai.so/axoncode/meta/${taskId}/lines`,
		token,
	)

	try {
		await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				[X_AXON_REPO]: repo,
			},
			body: JSON.stringify({ language, linesAdded, linesUpdated, linesDeleted }),
			signal: AbortSignal.timeout(10000),
		})
	} catch {
		// network/timeout errors: best-effort, swallow
	}
}