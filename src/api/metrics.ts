import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { getUrlFromToken } from "../auth/auth.js"
import { VERSION } from "../branding.js"
import { getConfigDir } from "../config/settings.js"
import {
	DEFAULT_HEADERS,
	getClientMetadataHeaders,
	X_AXON_REPO,
} from "./headers.js"

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
	model?: string
}

export interface UsageEvent {
	eventId?: string
	eventType: "user_message" | "committed_code" | "client_heartbeat"
	taskId?: string
	model?: string
	repo: string
	linesAdded?: number
	linesModified?: number
	linesDeleted?: number
	commitHash?: string
	timestamp?: string
}

export interface GitCommitMetrics {
	hash: string
	linesAdded: number
	linesDeleted: number
	timestamp: string
	authorEmail: string
}

export interface ObservedGitCommits {
	head?: string
	commits: GitCommitMetrics[]
}

/** Remove credentials and normalize common SSH remotes before telemetry. */
export function normalizeGitRemote(remote: string): string {
	const value = remote.trim()
	const scpMatch = value.match(/^(?:[^@]+@)?([^:]+):(.+)$/)
	if (scpMatch && !value.includes("://")) {
		return `https://${scpMatch[1]}/${scpMatch[2]}`
	}

	try {
		const url = new URL(value)
		url.username = ""
		url.password = ""
		url.search = ""
		url.hash = ""
		return url.toString().replace(/\/$/, "")
	} catch {
		return ""
	}
}

export function detectGitRepo(cwd: string): string {
	try {
		const remote = execFileSync("git", ["config", "--get", "remote.origin.url"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
		const normalized = normalizeGitRemote(remote)
		if (normalized) return normalized
	} catch {
		// not a git repo or no remote
	}
	return path.basename(cwd)
}

export function getGitHead(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
	} catch {
		return undefined
	}
}

const usageHeadsPath = (): string => path.join(getConfigDir(), "usage-git-heads.json")

const usageRepoKey = (cwd: string): string => `${detectGitRepo(cwd)}|${path.resolve(cwd)}`

export function getPersistedGitHead(cwd: string): string | undefined {
	try {
		const file = usageHeadsPath()
		if (!existsSync(file)) return undefined
		const heads = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
		return heads[usageRepoKey(cwd)]
	} catch {
		return undefined
	}
}

export function persistGitHead(cwd: string, head: string | undefined): void {
	if (!head) return
	try {
		const file = usageHeadsPath()
		mkdirSync(path.dirname(file), { recursive: true })
		let heads: Record<string, string> = {}
		if (existsSync(file)) {
			try {
				heads = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>
			} catch {
				// Replace an unreadable tracker file with a fresh map.
			}
		}
		heads[usageRepoKey(cwd)] = head
		writeFileSync(file, JSON.stringify(heads), { mode: 0o600 })
	} catch {
		// Local baselines are best-effort, like the network event itself.
	}
}

/**
 * Return commits created since the last observed HEAD. Branch switches and
 * rewritten/non-descendant histories become a new baseline instead of being
 * misreported as newly authored code.
 */
export function observeGitCommits(cwd: string, previousHead?: string): ObservedGitCommits {
	const head = getGitHead(cwd)
	if (!head || !previousHead || head === previousHead) return { head, commits: [] }

	try {
		execFileSync("git", ["merge-base", "--is-ancestor", previousHead, head], {
			cwd,
			stdio: "ignore",
		})
	} catch {
		return { head, commits: [] }
	}

	try {
		let configuredAuthorEmail = ""
		try {
			configuredAuthorEmail = execFileSync("git", ["config", "--get", "user.email"], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			})
				.toString()
				.trim()
				.toLowerCase()
		} catch {
			// A repository can still have commits when identity comes from env vars.
		}
		const hashes = execFileSync("git", ["rev-list", "--reverse", `${previousHead}..${head}`], {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim()
			.split("\n")
			.filter(Boolean)

		const commits = hashes.map((hash) => {
			const authorEmail = execFileSync("git", ["show", "-s", "--format=%ae", hash], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			})
				.toString()
				.trim()
			const numstat = execFileSync("git", ["show", "--numstat", "--format=", "--no-renames", hash], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			}).toString()
			let linesAdded = 0
			let linesDeleted = 0
			for (const line of numstat.split("\n")) {
				const [added, deleted] = line.split("\t")
				if (/^\d+$/.test(added)) linesAdded += Number(added)
				if (/^\d+$/.test(deleted)) linesDeleted += Number(deleted)
			}
			const timestamp = execFileSync("git", ["show", "-s", "--format=%cI", hash], {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
			})
				.toString()
				.trim()
			return { hash, linesAdded, linesDeleted, timestamp, authorEmail }
		}).filter(
			(commit) =>
				!configuredAuthorEmail || commit.authorEmail.toLowerCase() === configuredAuthorEmail,
		)

		return { head, commits }
	} catch {
		return { head, commits: [] }
	}
}

/** Report a non-content usage event. User prompt text is never transmitted. */
export async function reportUsageEvent(token: string, event: UsageEvent): Promise<void> {
	if (!token) return
	const url = getUrlFromToken("https://api.matterai.so/axoncode/usage/events", token)

	try {
		await fetch(url, {
			method: "POST",
			headers: {
				...DEFAULT_HEADERS,
				...getClientMetadataHeaders(0),
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				[X_AXON_REPO]: event.repo,
			},
			body: JSON.stringify({
				...event,
				eventId: event.eventId || randomUUID(),
				client: "orbcode",
				clientVersion: VERSION,
				ideName: "CLI",
			}),
			signal: AbortSignal.timeout(10000),
		})
	} catch {
		// network/timeout errors: best-effort, swallow
	}
}

/**
 * POST accepted code metrics to `/axoncode/meta/<taskId>/lines`.
 * Best-effort: network errors are swallowed so metrics never break a session.
 * Works for both user-approved and auto-approved edits — the caller reports
 * only after the edit has been written to disk.
 */
export async function reportLineMetrics(options: ReportLineMetricsOptions): Promise<void> {
	const { taskId, token, repo, language, linesAdded, linesDeleted, model } = options
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
				...DEFAULT_HEADERS,
				...getClientMetadataHeaders(0),
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				[X_AXON_REPO]: repo,
			},
			body: JSON.stringify({
				eventId: randomUUID(),
				language,
				linesAdded,
				linesUpdated,
				linesDeleted,
				model,
				client: "orbcode",
				clientVersion: VERSION,
				ideName: "CLI",
			}),
			signal: AbortSignal.timeout(10000),
		})
	} catch {
		// network/timeout errors: best-effort, swallow
	}
}
