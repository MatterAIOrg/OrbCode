import * as path from "node:path"

import {
	MAX_SEARCH_LINE_LENGTH,
	type SearchContextLine,
	type SearchMatch,
	type SearchPage,
	serializeSearchCursor,
} from "./types.js"

export function truncateSearchLine(line: string, maxLength = MAX_SEARCH_LINE_LENGTH): string {
	const normalized = line.replace(/[\r\n]+$/g, "")
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength)} [truncated]` : normalized
}

function addContextLine(lines: Map<number, string>, contextLine: SearchContextLine): void {
	if (!lines.has(contextLine.line)) {
		lines.set(contextLine.line, `  ${contextLine.line} | ${truncateSearchLine(contextLine.text)}`)
	}
}

/** Remove model-only pagination metadata before rendering a search result in the TUI. */
export function stripSearchPageMetadataForDisplay(text: string): string {
	const lines = text.split("\n")
	let firstVisibleLine = 0
	while (
		firstVisibleLine < lines.length &&
		/^(?:Engine|Matches|Next cursor|Restarted|Warning):/.test(lines[firstVisibleLine])
	) {
		firstVisibleLine++
	}
	while (firstVisibleLine < lines.length && lines[firstVisibleLine].trim() === "") firstVisibleLine++
	return lines.slice(firstVisibleLine).join("\n")
}

export function formatSearchPage(page: SearchPage): string {
	const cursor = serializeSearchCursor(page.nextCursor)
	const nextCursor = cursor ?? "none (search complete; do not continue)"
	const header = [`Engine: ${page.engine}`, `Matches: ${page.matches.length}`, `Next cursor: ${nextCursor}`]
	if (page.restarted) header.push("Restarted: yes")
	if (page.warning) header.push(`Warning: ${page.warning}`)
	if (page.matches.length === 0) return header.join("\n")

	const byFile = new Map<string, SearchMatch[]>()
	for (const match of page.matches) {
		const file = match.file.split(path.sep).join("/")
		const existing = byFile.get(file)
		if (existing) existing.push(match)
		else byFile.set(file, [match])
	}

	const body: string[] = []
	for (const [file, matches] of byFile) {
		body.push(`# ${file}`)
		const lines = new Map<number, string>()
		for (const match of matches) {
			for (const line of match.contextBefore ?? []) addContextLine(lines, line)
			const definition = match.isDefinition ? " def" : ""
			lines.set(match.line, `> ${match.line}:${match.column}${definition} | ${truncateSearchLine(match.text)}`)
			for (const line of match.contextAfter ?? []) addContextLine(lines, line)
		}
		body.push(...[...lines.entries()].sort(([a], [b]) => a - b).map(([, value]) => value), "")
	}

	return `${header.join("\n")}\n\n${body.join("\n").trimEnd()}`
}
