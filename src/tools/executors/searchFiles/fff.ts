import * as path from "node:path"

import type { FileFinder, GrepCursor, GrepMatch } from "@ff-labs/fff-node"

import {
	MAX_MATCHES_PER_FILE,
	SEARCH_EXCLUDED_DIRECTORY_NAMES,
	SEARCH_EXCLUDED_GLOBS,
	type SearchContextLine,
	type SearchMatch,
	type SearchOptions,
	type SearchPage,
} from "./types.js"

type FffModule = typeof import("@ff-labs/fff-node")

const FINDER_INIT_TIMEOUT_MS = 10_000
const FINDER_FAILURE_COOLDOWN_MS = 30_000

const persistentFinders = new Map<string, Promise<FileFinder>>()
const finderFailures = new Map<string, { retryAfter: number; message: string }>()
const liveFinders = new Set<FileFinder>()
let fffModulePromise: Promise<FffModule> | undefined
let disposalPromise: Promise<void> | undefined
let activeOperations = 0
let idlePromise: Promise<void> | undefined
let resolveIdle: (() => void) | undefined

async function acquireFffOperation(): Promise<void> {
	while (disposalPromise) {
		try {
			await disposalPromise
		} catch {
			// Cleanup failures are reported to the disposer. A later search may retry.
		}
	}
	activeOperations++
}

function releaseFffOperation(): void {
	activeOperations--
	if (activeOperations === 0) {
		resolveIdle?.()
		resolveIdle = undefined
		idlePromise = undefined
	}
}

function waitForFffOperations(): Promise<void> {
	if (activeOperations === 0) return Promise.resolve()
	if (!idlePromise) {
		idlePromise = new Promise<void>((resolve) => {
			resolveIdle = resolve
		})
	}
	return idlePromise
}

async function loadFffModule(): Promise<FffModule> {
	if (!fffModulePromise) {
		const loading = import("@ff-labs/fff-node")
		fffModulePromise = loading
		loading.catch(() => {
			if (fffModulePromise === loading) fffModulePromise = undefined
		})
	}
	return fffModulePromise
}

function destroyFinder(finder: FileFinder): void {
	if (!finder.isDestroyed) finder.destroy()
	liveFinders.delete(finder)
}

async function createFinder(basePath: string, watch: boolean): Promise<FileFinder> {
	const { FileFinder } = await loadFffModule()
	const created = FileFinder.create({
		basePath,
		aiMode: true,
		disableWatch: !watch,
		followSymlinks: false,
	})
	if (!created.ok) throw new Error(created.error)

	const finder = created.value
	liveFinders.add(finder)
	try {
		const ready = await finder.waitForScan(FINDER_INIT_TIMEOUT_MS)
		if (!ready.ok || !ready.value) {
			throw new Error(ready.ok ? `FFF initial scan timed out after ${FINDER_INIT_TIMEOUT_MS}ms` : ready.error)
		}
		return finder
	} catch (error) {
		try {
			destroyFinder(finder)
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "FFF initialization and cleanup both failed")
		}
		throw error
	}
}

async function getPersistentFinder(basePath: string): Promise<FileFinder> {
	const normalized = path.resolve(basePath)
	const failure = finderFailures.get(normalized)
	if (failure && failure.retryAfter > Date.now()) throw new Error(failure.message)
	if (failure) finderFailures.delete(normalized)

	const cached = persistentFinders.get(normalized)
	if (cached) return cached

	const creating = createFinder(normalized, true)
	persistentFinders.set(normalized, creating)
	try {
		const finder = await creating
		finderFailures.delete(normalized)
		return finder
	} catch (error) {
		if (persistentFinders.get(normalized) === creating) persistentFinders.delete(normalized)
		const message = error instanceof Error ? error.message : String(error)
		finderFailures.set(normalized, { retryAfter: Date.now() + FINDER_FAILURE_COOLDOWN_MS, message })
		throw error
	}
}

function isInsidePath(parent: string, child: string): boolean {
	const relative = path.relative(parent, child)
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function isUnsafeFffPathConstraint(relativePath: string): boolean {
	return /[\s*?[\]{}!]/.test(relativePath)
}

function isInsideExcludedDirectory(relativePath: string): boolean {
	const excluded = new Set<string>(SEARCH_EXCLUDED_DIRECTORY_NAMES)
	return relativePath.split("/").some((segment) => excluded.has(segment))
}

/** Protect regex tokens from FFF's inline path/glob constraint parser. */
export function encodeRegexForFffQuery(regex: string): string {
	let encoded = regex
		.replace(/\\\//g, "\\x2F")
		.replace(/\//g, "\\x2F")
		.replace(/\r/g, "\\x0D")
		.replace(/\n/g, "\\x0A")
		.replace(/\t/g, "\\x09")
		.replace(/\f/g, "\\x0C")
		.replace(/\v/g, "\\x0B")
		.replace(/ /g, "\\x20")
	if (encoded.startsWith("!")) encoded = `\\x21${encoded.slice(1)}`
	return encoded
}

function buildFffQuery(cwd: string, directoryPath: string, regex: string, filePattern?: string) {
	const workspace = path.resolve(cwd)
	const directory = path.resolve(directoryPath)
	const workspaceRelative = path.relative(workspace, directory).split(path.sep).join("/")
	const persistent =
		isInsidePath(workspace, directory) &&
		!isUnsafeFffPathConstraint(workspaceRelative) &&
		!isInsideExcludedDirectory(workspaceRelative)
	const basePath = persistent ? workspace : directory
	const constraints: string[] = []

	if (filePattern && /\s/.test(filePattern)) {
		throw new Error("FFF cannot safely encode a whitespace-containing file pattern")
	}
	if (persistent && workspaceRelative) {
		constraints.push(`${workspaceRelative}/**`)
		if (filePattern?.startsWith("!")) {
			const pattern = filePattern.slice(1)
			constraints.push(pattern.includes("/") ? `!${workspaceRelative}/${pattern}` : filePattern)
		} else if (filePattern?.includes("/")) constraints.push(`${workspaceRelative}/${filePattern}`)
		else if (filePattern) constraints.push(filePattern)
	} else if (filePattern) {
		constraints.push(filePattern)
	}
	constraints.push(...SEARCH_EXCLUDED_GLOBS.map((glob) => `!${glob}`))

	constraints.push(encodeRegexForFffQuery(regex))
	return { basePath, directory, persistent, query: constraints.join(" ") }
}

function contextLines(lines: string[] | undefined, firstLine: number): SearchContextLine[] | undefined {
	return lines?.length ? lines.map((text, index) => ({ line: firstLine + index, text })) : undefined
}

function toSearchMatch(cwd: string, basePath: string, match: GrepMatch): SearchMatch {
	const before = match.contextBefore ?? []
	return {
		file: path.relative(cwd, path.join(basePath, match.relativePath)),
		line: match.lineNumber,
		column: match.col + 1,
		text: match.lineContent,
		isDefinition: match.isDefinition,
		contextBefore: contextLines(before, match.lineNumber - before.length),
		contextAfter: contextLines(match.contextAfter, match.lineNumber + 1),
	}
}

function nativeCursor(offset: number): GrepCursor {
	return { __brand: "GrepCursor", _offset: offset }
}

export async function searchFilesWithFff(
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern: string | undefined,
	options: SearchOptions,
): Promise<SearchPage> {
	await acquireFffOperation()
	let finder: FileFinder | undefined
	let persistent = false

	try {
		if (options.cursor?.engine === "ripgrep") throw new Error("A ripgrep cursor cannot be continued by FFF")

		const request = buildFffQuery(cwd, directoryPath, regex, filePattern)
		persistent = request.persistent
		finder = persistent ? await getPersistentFinder(request.basePath) : await createFinder(request.basePath, false)
		let cursor = options.cursor ? nativeCursor(options.cursor.offset) : null
		let nextCursor: GrepCursor | null = null
		const matches: SearchMatch[] = []

		for (let page = 0; page < 100 && matches.length < options.maxResults; page++) {
			const result = finder.grep(request.query, {
				mode: "regex",
				cursor,
				pageSize: options.maxResults - matches.length,
				maxMatchesPerFile: MAX_MATCHES_PER_FILE,
				beforeContext: options.contextLines,
				afterContext: options.contextLines,
				classifyDefinitions: true,
				smartCase: false,
			})
			if (!result.ok) throw new Error(result.error)
			if (result.value.regexFallbackError) throw new Error(result.value.regexFallbackError)

			for (const match of result.value.items) {
				const absolute = path.join(request.basePath, match.relativePath)
				if (isInsidePath(request.directory, absolute)) matches.push(toSearchMatch(cwd, request.basePath, match))
			}

			nextCursor = result.value.nextCursor
			if (!nextCursor || matches.length >= options.maxResults) break
			cursor = nextCursor
		}

		return {
			engine: "fff",
			matches,
			nextCursor: nextCursor
				? { engine: "fff", offset: nextCursor._offset, fingerprint: options.fingerprint }
				: null,
		}
	} finally {
		try {
			if (finder && !persistent) destroyFinder(finder)
		} finally {
			releaseFffOperation()
		}
	}
}

export function disposeFffSearch(): Promise<void> {
	if (disposalPromise) return disposalPromise

	let resolveDisposal!: () => void
	let rejectDisposal!: (error: unknown) => void
	const disposing = new Promise<void>((resolve, reject) => {
		resolveDisposal = resolve
		rejectDisposal = reject
	})
	disposalPromise = disposing

	void (async () => {
		await waitForFffOperations()
		const cached = [...persistentFinders.values()]
		persistentFinders.clear()
		finderFailures.clear()
		const errors: unknown[] = []

		for (const finderPromise of cached) {
			try {
				destroyFinder(await finderPromise)
			} catch (error) {
				errors.push(error)
			}
		}
		for (const finder of [...liveFinders]) {
			try {
				destroyFinder(finder)
			} catch (error) {
				errors.push(error)
			}
		}

		if (liveFinders.size === 0 && fffModulePromise) {
			try {
				const fff = await fffModulePromise
				fff.closeLibrary()
				fffModulePromise = undefined
			} catch (error) {
				errors.push(error)
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "FFF cleanup failed")
	})().then(resolveDisposal, rejectDisposal)

	void disposing.then(
		() => {
			if (disposalPromise === disposing) disposalPromise = undefined
		},
		() => {
			if (disposalPromise === disposing) disposalPromise = undefined
		},
	)
	return disposing
}
