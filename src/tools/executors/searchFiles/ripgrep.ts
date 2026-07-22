import * as childProcess from "node:child_process"
import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as readline from "node:readline"

import picomatch from "picomatch"

import {
	MAX_MATCHES_PER_FILE,
	SEARCH_EXCLUDED_GLOBS,
	type SearchContextLine,
	type SearchMatch,
	type SearchOptions,
	type SearchPage,
} from "./types.js"

const activeProcesses = new Set<childProcess.ChildProcessWithoutNullStreams>()
const cancelledProcesses = new WeakSet<childProcess.ChildProcessWithoutNullStreams>()
let disposalPromise: Promise<void> | undefined
let disposalEpoch = 0
let activeOperations = 0
let idlePromise: Promise<void> | undefined
let resolveIdle: (() => void) | undefined

function pathText(value: { text?: string } | undefined): string | undefined {
	return value?.text
}

async function resolveRipgrepExecutables(): Promise<string[]> {
	const executables: string[] = []
	try {
		const { rgPath } = await import("@vscode/ripgrep")
		await fs.access(rgPath, fsConstants.X_OK)
		executables.push(rgPath)
	} catch {
		// The optional bundled binary may be absent or unsupported on this host.
	}
	if (!executables.includes("rg")) executables.push("rg")
	return executables
}

async function acquireRipgrepOperation(): Promise<number> {
	while (disposalPromise) await disposalPromise
	activeOperations++
	return disposalEpoch
}

function releaseRipgrepOperation(): void {
	activeOperations--
	if (activeOperations === 0) {
		resolveIdle?.()
		resolveIdle = undefined
		idlePromise = undefined
	}
}

function waitForRipgrepOperations(): Promise<void> {
	if (activeOperations === 0) return Promise.resolve()
	if (!idlePromise) {
		idlePromise = new Promise<void>((resolve) => {
			resolveIdle = resolve
		})
	}
	return idlePromise
}

function runRipgrep(
	executable: string,
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern: string | undefined,
	options: SearchOptions,
): Promise<SearchPage> {
	const offset = options.cursor?.engine === "ripgrep" ? options.cursor.offset : 0
	const args = ["--json", "--no-messages", "--max-filesize", "10M", "--context", String(options.contextLines)]
	if (filePattern && !filePattern.startsWith("!")) {
		const basenamePattern = path.posix.basename(filePattern)
		args.push("--type-add", `orbcode:${basenamePattern}`, "--type", "orbcode")
	}
	args.push(...SEARCH_EXCLUDED_GLOBS.flatMap((glob) => ["--glob", `!${glob}`]), "-e", regex, ".")
	const negated = filePattern?.startsWith("!") ?? false
	const patternBody = negated ? filePattern!.slice(1) : filePattern
	const expandedPattern = patternBody?.includes("/") ? patternBody : patternBody ? `**/${patternBody}` : undefined
	const matchesFile = expandedPattern ? picomatch(negated ? `!${expandedPattern}` : expandedPattern, { dot: true }) : () => true

	return new Promise<SearchPage>((resolve, reject) => {
		const rgProcess = childProcess.spawn(executable, args, { cwd: directoryPath, windowsHide: true })
		activeProcesses.add(rgProcess)
		const lines = readline.createInterface({ input: rgProcess.stdout, crlfDelay: Infinity })
		const matches: SearchMatch[] = []
		let currentFile: string | undefined
		let currentFileMatches = false
		let matchesSeenInFile = 0
		let recentContext: SearchContextLine[] = []
		let lastMatch: SearchMatch | undefined
		let rawMatchesSeen = 0
		let pageFull = false
		let intentionallyKilled = false
		let settled = false
		let stderr = ""

		const stop = () => {
			if (intentionallyKilled) return
			intentionallyKilled = true
			lines.close()
			rgProcess.kill()
		}

		rgProcess.stderr.on("data", (data) => {
			stderr += data.toString()
		})

		lines.on("line", (rawLine) => {
			if (!rawLine || intentionallyKilled) return
			let parsed: any
			try {
				parsed = JSON.parse(rawLine)
			} catch {
				return
			}

			if (parsed.type === "begin") {
				currentFile = pathText(parsed.data?.path)
				const absoluteFile = currentFile
					? path.isAbsolute(currentFile)
						? currentFile
						: path.resolve(directoryPath, currentFile)
					: undefined
				const relativeFile = absoluteFile
					? path.relative(directoryPath, absoluteFile).split(path.sep).join("/")
					: ""
				currentFileMatches = Boolean(currentFile && matchesFile(relativeFile))
				matchesSeenInFile = 0
				recentContext = []
				lastMatch = undefined
				return
			}
			if (parsed.type === "end") {
				if (pageFull) stop()
				currentFile = undefined
				currentFileMatches = false
				matchesSeenInFile = 0
				recentContext = []
				lastMatch = undefined
				return
			}
			if (!currentFile || !currentFileMatches || (parsed.type !== "match" && parsed.type !== "context")) return

			const line = Number(parsed.data?.line_number)
			const text = String(parsed.data?.lines?.text ?? "").replace(/[\r\n]+$/g, "")
			if (!Number.isFinite(line)) return

			if (parsed.type === "context") {
				const context = { line, text }
				if (lastMatch && line > lastMatch.line && line <= lastMatch.line + options.contextLines) {
					lastMatch.contextAfter ??= []
					if (lastMatch.contextAfter.length < options.contextLines) lastMatch.contextAfter.push(context)
				}
				recentContext.push(context)
				if (recentContext.length > options.contextLines) recentContext.shift()
				if (pageFull && (!lastMatch || (lastMatch.contextAfter?.length ?? 0) >= options.contextLines)) stop()
				return
			}

			// Do not advance the raw cursor for a match that was not returned. This
			// preserves an adjacent match when the previous page is collecting context.
			if (pageFull || matches.length >= options.maxResults) {
				stop()
				return
			}

			rawMatchesSeen++
			matchesSeenInFile++
			if (rawMatchesSeen <= offset || matchesSeenInFile > MAX_MATCHES_PER_FILE) return

			const absoluteFile = path.isAbsolute(currentFile) ? currentFile : path.resolve(directoryPath, currentFile)
			const match: SearchMatch = {
				file: path.relative(cwd, absoluteFile),
				line,
				column: Number(parsed.data?.submatches?.[0]?.start ?? 0) + 1,
				text,
				contextBefore: recentContext.filter(
					(context) => context.line >= line - options.contextLines && context.line < line,
				),
			}
			matches.push(match)
			lastMatch = match
			if (matches.length >= options.maxResults) {
				pageFull = true
				if (options.contextLines === 0) stop()
			}
		})

		rgProcess.on("error", (error) => {
			activeProcesses.delete(rgProcess)
			if (settled) return
			settled = true
			reject(new Error(`ripgrep process error: ${error.message}`))
		})
		rgProcess.on("close", (code) => {
			activeProcesses.delete(rgProcess)
			if (settled) return
			settled = true
			if (cancelledProcesses.has(rgProcess)) {
				reject(new Error("ripgrep search was cancelled during shutdown"))
				return
			}
			if (!intentionallyKilled && code !== 0 && code !== 1) {
				reject(new Error(`ripgrep process error: ${stderr.trim() || `exit code ${code}`}`))
				return
			}
			resolve({
				engine: "ripgrep",
				matches,
				nextCursor: pageFull
					? { engine: "ripgrep", offset: rawMatchesSeen, fingerprint: options.fingerprint }
					: null,
			})
		})
	})
}

export async function searchFilesWithRipgrep(
	cwd: string,
	directoryPath: string,
	regex: string,
	filePattern: string | undefined,
	options: SearchOptions,
): Promise<SearchPage> {
	const epoch = await acquireRipgrepOperation()
	try {
		const executables = await resolveRipgrepExecutables()
		if (epoch !== disposalEpoch) throw new Error("ripgrep search was cancelled during shutdown")

		let lastError: unknown
		for (const executable of executables) {
			try {
				return await runRipgrep(executable, cwd, directoryPath, regex, filePattern, options)
			} catch (error) {
				lastError = error
				if (epoch !== disposalEpoch) throw error
			}
		}
		throw lastError ?? new Error("No ripgrep executable is available")
	} finally {
		releaseRipgrepOperation()
	}
}

function terminateRipgrep(rgProcess: childProcess.ChildProcessWithoutNullStreams): Promise<void> {
	if (rgProcess.exitCode !== null) return Promise.resolve()
	cancelledProcesses.add(rgProcess)
	return new Promise<void>((resolve) => {
		let forceTimer: ReturnType<typeof setTimeout> | undefined
		let capTimer: ReturnType<typeof setTimeout> | undefined
		let finished = false
		const done = () => {
			if (finished) return
			finished = true
			if (forceTimer) clearTimeout(forceTimer)
			if (capTimer) clearTimeout(capTimer)
			resolve()
		}
		rgProcess.once("close", done)
		rgProcess.once("error", done)
		try {
			rgProcess.kill()
			forceTimer = setTimeout(() => {
				try {
					rgProcess.kill("SIGKILL")
				} catch {
					// The process may have exited between the timer firing and kill().
				}
			}, 250)
			forceTimer.unref?.()
			capTimer = setTimeout(done, 1000)
			capTimer.unref?.()
		} catch {
			done()
		}
	})
}

export function disposeRipgrepSearch(): Promise<void> {
	if (disposalPromise) return disposalPromise

	let resolveDisposal!: () => void
	const disposing = new Promise<void>((resolve) => {
		resolveDisposal = resolve
	})
	disposalPromise = disposing
	disposalEpoch++
	void (async () => {
		await Promise.all([...activeProcesses].map(terminateRipgrep))
		await waitForRipgrepOperations()
	})().then(resolveDisposal, resolveDisposal)
	void disposing.then(() => {
		if (disposalPromise === disposing) disposalPromise = undefined
	})
	return disposing
}
