import { createHash } from "node:crypto"
import * as path from "node:path"

export const DEFAULT_SEARCH_RESULTS = 50
export const MAX_SEARCH_RESULTS = 100
export const MAX_MATCHES_PER_FILE = 3
export const MAX_SEARCH_CONTEXT_LINES = 2
export const MAX_SEARCH_LINE_LENGTH = 300
export const SEARCH_EXCLUDED_DIRECTORY_NAMES = [
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	"__pycache__",
	".venv",
	"venv",
] as const
export const SEARCH_EXCLUDED_GLOBS = SEARCH_EXCLUDED_DIRECTORY_NAMES.map((name) => `**/${name}/**`)

export type SearchEngine = "fff" | "ripgrep"

export interface SearchCursor {
	engine: SearchEngine
	offset: number
	fingerprint: string
}

export interface SearchContextLine {
	line: number
	text: string
}

export interface SearchMatch {
	file: string
	line: number
	column: number
	text: string
	isDefinition?: boolean
	contextBefore?: SearchContextLine[]
	contextAfter?: SearchContextLine[]
}

export interface SearchPage {
	engine: SearchEngine
	matches: SearchMatch[]
	nextCursor: SearchCursor | null
	warning?: string
	restarted?: boolean
}

export interface SearchOptions {
	cursor: SearchCursor | null
	maxResults: number
	contextLines: number
	fingerprint: string
}

export function normalizeNullableString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined
	const normalized = value.trim()
	return normalized === "" || normalized.toLowerCase() === "null" ? undefined : normalized
}

export function normalizeSearchFilePattern(value: unknown): string | undefined {
	const pattern = normalizeNullableString(value)
	if (!pattern || pattern === "*") return undefined
	return pattern.startsWith(".") && !pattern.includes("*") ? `*${pattern}` : pattern
}

function boundedInteger(value: unknown, name: string, fallback: number, min: number, max: number): number {
	if (value == null || value === "" || (typeof value === "string" && value.trim().toLowerCase() === "null")) {
		return fallback
	}

	const parsed = typeof value === "number" ? value : Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`${name} must be an integer from ${min} to ${max}, or null`)
	}
	return parsed
}

export function createSearchFingerprint(directoryPath: string, regex: string, filePattern?: string): string {
	return createHash("sha256")
		.update(JSON.stringify([path.resolve(directoryPath), regex, filePattern ?? null]))
		.digest("hex")
		.slice(0, 16)
}

export function parseSearchCursor(value: unknown, expectedFingerprint: string): SearchCursor | null {
	if (value == null) return null
	if (typeof value !== "string") {
		throw new Error("search_files cursor must be the string returned by a previous search, or null")
	}

	const normalized = value.trim()
	if (normalized === "" || normalized.toLowerCase() === "null") return null
	if (normalized.toLowerCase() === "none") {
		throw new Error("search_files reported no next cursor because the search is complete; do not continue it")
	}

	const match = /^(fff|ripgrep):(\d+):([a-f0-9]{16})$/.exec(normalized)
	if (!match) {
		throw new Error("search_files cursor is invalid; copy it exactly from a previous identical search")
	}

	const offset = Number(match[2])
	if (!Number.isSafeInteger(offset)) throw new Error("search_files cursor offset is too large")
	if (match[3] !== expectedFingerprint) {
		throw new Error("search_files cursor belongs to a different path, regex, or file_pattern")
	}

	return { engine: match[1] as SearchEngine, offset, fingerprint: match[3] }
}

export function serializeSearchCursor(cursor: SearchCursor | null): string | null {
	return cursor ? `${cursor.engine}:${cursor.offset}:${cursor.fingerprint}` : null
}

export function parseSearchOptions(args: Record<string, unknown>, fingerprint: string): SearchOptions {
	return {
		cursor: parseSearchCursor(args.cursor, fingerprint),
		maxResults: boundedInteger(args.max_results, "max_results", DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS),
		contextLines: boundedInteger(args.context_lines, "context_lines", 0, 0, MAX_SEARCH_CONTEXT_LINES),
		fingerprint,
	}
}
