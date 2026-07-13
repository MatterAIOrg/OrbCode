import * as fs from "node:fs"
import * as path from "node:path"
import type OpenAI from "openai"

import type { AttachmentSummary } from "../attachments.js"
import { getConfigDir } from "../config/settings.js"

export type SessionTranscriptEntry =
	| { kind: "user"; text: string; attachments?: AttachmentSummary[] }
	| { kind: "assistant"; text: string }
	| { kind: "reasoning"; text: string; durationMs: number }
	| {
			kind: "tool"
			name: string
			summary: string
			resultPreview: string
			isError: boolean
			diff?: string
	  }
	| { kind: "info"; text: string }
	| { kind: "error"; text: string }
	| { kind: "completion"; text: string }

export interface SessionData {
	id: string
	cwd: string
	model: string
	/** first user prompt, used as the list label */
	title: string
	createdAt: string
	updatedAt: string
	totalCost: number
	/**
	 * Last reported context window usage (input + output tokens from the most
	 * recent `usage` chunk). Restored on resume so the status bar keeps showing
	 * the correct number after restart.
	 */
	contextTokens: number
	todos: string
	messages: OpenAI.Chat.ChatCompletionMessageParam[]
	/** Exact visible TUI history. Optional for sessions written before v0.4.2. */
	transcript?: SessionTranscriptEntry[]
}

const MAX_SESSIONS_LISTED = 25

function getSessionsDir(): string {
	return path.join(getConfigDir(), "sessions")
}

/** On-disk path of a session's transcript, also passed to hooks. */
export function getSessionFilePath(id: string): string {
	return path.join(getSessionsDir(), `${id}.json`)
}

export function saveSession(data: SessionData): void {
	const dir = getSessionsDir()
	fs.mkdirSync(dir, { recursive: true })
	fs.writeFileSync(getSessionFilePath(data.id), JSON.stringify(data), { mode: 0o600 })
}

export function loadSessionById(id: string): SessionData | undefined {
	try {
		return JSON.parse(fs.readFileSync(path.join(getSessionsDir(), `${id}.json`), "utf8")) as SessionData
	} catch {
		return undefined
	}
}

/** Sessions for a workspace, most recently updated first. */
export function listSessions(cwd: string): SessionData[] {
	let files: string[]
	try {
		files = fs.readdirSync(getSessionsDir()).filter((f) => f.endsWith(".json"))
	} catch {
		return []
	}
	const sessions: SessionData[] = []
	for (const file of files) {
		try {
			const data = JSON.parse(fs.readFileSync(path.join(getSessionsDir(), file), "utf8")) as SessionData
			if (data.cwd === cwd && Array.isArray(data.messages) && data.messages.length > 0) {
				sessions.push(data)
			}
		} catch {
			// skip unreadable session files
		}
	}
	sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
	return sessions.slice(0, MAX_SESSIONS_LISTED)
}
