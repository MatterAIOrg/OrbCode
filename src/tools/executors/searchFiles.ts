import * as fs from "node:fs"

import { type ToolContext, type ToolResult, resolveWorkspacePath } from "../types.js"
import { searchFilesWithFff, disposeFffSearch } from "./searchFiles/fff.js"
import { formatSearchPage } from "./searchFiles/format.js"
import { disposeRipgrepSearch, searchFilesWithRipgrep } from "./searchFiles/ripgrep.js"
import {
	createSearchFingerprint,
	normalizeSearchFilePattern,
	parseSearchOptions,
	type SearchPage,
} from "./searchFiles/types.js"

let disposalPromise: Promise<void> | undefined
let activeSearches = 0
let idlePromise: Promise<void> | undefined
let resolveIdle: (() => void) | undefined

async function acquireSearchOperation(): Promise<void> {
	while (disposalPromise) {
		try {
			await disposalPromise
		} catch {
			// Cleanup errors are reported to the disposer; later sessions may retry.
		}
	}
	activeSearches++
}

function releaseSearchOperation(): void {
	activeSearches--
	if (activeSearches === 0) {
		resolveIdle?.()
		resolveIdle = undefined
		idlePromise = undefined
	}
}

function waitForSearchOperations(): Promise<void> {
	if (activeSearches === 0) return Promise.resolve()
	if (!idlePromise) {
		idlePromise = new Promise<void>((resolve) => {
			resolveIdle = resolve
		})
	}
	return idlePromise
}

export async function searchFiles(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	await acquireSearchOperation()
	try {
		const directoryPath = resolveWorkspacePath(context.cwd, String(args.path ?? "."))
		if (typeof args.regex !== "string" || args.regex.length === 0) {
			throw new Error("regex must be a non-empty string")
		}
		const regex = args.regex
		const filePattern = normalizeSearchFilePattern(args.file_pattern)
		if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
			return { text: `Directory not found: ${directoryPath}`, isError: true }
		}

		const fingerprint = createSearchFingerprint(directoryPath, regex, filePattern)
		const options = parseSearchOptions(args, fingerprint)
		let page: SearchPage

		if (options.cursor?.engine === "fff") {
			page = await searchFilesWithFff(context.cwd, directoryPath, regex, filePattern, options)
		} else {
			try {
				// Ripgrep is the fast, deterministic default used by coding agents. FFF
				// remains available as a fallback for installations where the bundled
				// ripgrep binary is unavailable or cannot execute the requested pattern.
				page = await searchFilesWithRipgrep(context.cwd, directoryPath, regex, filePattern, options)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				page = await searchFilesWithFff(context.cwd, directoryPath, regex, filePattern, {
					...options,
					cursor: null,
				})
				page.warning = `ripgrep failed; used FFF fallback (${message})`
			}
		}

		const output = formatSearchPage(page)

		// Append guidance when a search returns no matches so the model changes
		// the query instead of repeating the same search unchanged.
		if (page.matches.length === 0) {
			return {
				text: output + "\n\nNo matches found. Change the regex, path, or file_pattern before retrying; do not repeat this unchanged search.",
			}
		}

		return { text: output }
	} catch (error) {
		return { text: `Error searching files:\n${error instanceof Error ? error.message : String(error)}`, isError: true }
	} finally {
		releaseSearchOperation()
	}
}

export function disposeSearchFiles(): Promise<void> {
	if (disposalPromise) return disposalPromise

	let resolveDisposal!: () => void
	let rejectDisposal!: (error: unknown) => void
	const disposing = new Promise<void>((resolve, reject) => {
		resolveDisposal = resolve
		rejectDisposal = reject
	})
	disposalPromise = disposing
	void (async () => {
		await waitForSearchOperations()
		const errors: unknown[] = []
		try {
			await disposeFffSearch()
		} catch (error) {
			errors.push(error)
		}
		try {
			await disposeRipgrepSearch()
		} catch (error) {
			errors.push(error)
		}
		if (errors.length > 0) throw new AggregateError(errors, "Search cleanup failed")
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

export { formatSearchPage, stripSearchPageMetadataForDisplay } from "./searchFiles/format.js"
export {
	createSearchFingerprint,
	normalizeNullableString,
	normalizeSearchFilePattern,
	parseSearchCursor,
	parseSearchOptions,
	serializeSearchCursor,
} from "./searchFiles/types.js"
