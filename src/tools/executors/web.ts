import { getUrlFromToken } from "../../auth/auth.js"
import type { ToolContext, ToolResult } from "../types.js"

// Both web tools call the MatterAI backend, same as the Orbital extension.

interface WebSearchResult {
	title: string
	url: string
	publish_date?: string
	excerpts?: string[]
}

export async function webSearch(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const query = String(args.query ?? "")
	if (!query) return { text: "FAILED: query is empty", isError: true }

	try {
		const url = getUrlFromToken("https://api.matterai.so/axoncode/websearch", context.token)
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${context.token}`,
			},
			body: JSON.stringify({ query }),
			signal: AbortSignal.timeout(30_000),
		})
		if (!response.ok) {
			return { text: `Web search failed (${response.status})`, isError: true }
		}
		const data = (await response.json()) as { results?: WebSearchResult[] }
		const results = data.results
		if (!results || results.length === 0) {
			return { text: `No results found for query: "${query}"` }
		}
		const formatted = results
			.map((result, index) => {
				let entry = `[${index + 1}] ${result.title}\nURL: ${result.url}`
				if (result.publish_date) entry += `\nPublished: ${result.publish_date}`
				if (result.excerpts && result.excerpts.length > 0) entry += `\n\n${result.excerpts.join("\n\n")}`
				return entry
			})
			.join("\n\n---\n\n")
		return { text: `Web search results for "${query}":\n\n${formatted}` }
	} catch (error) {
		return { text: `Web search failed: ${(error as Error).message}`, isError: true }
	}
}

export async function webFetch(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const targetUrl = String(args.url ?? "")
	try {
		new URL(targetUrl)
	} catch {
		return { text: `Invalid URL format: ${targetUrl}`, isError: true }
	}

	try {
		const apiUrl = getUrlFromToken("https://api.matterai.so/axoncode/webFetch", context.token)
		const response = await fetch(apiUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${context.token}`,
			},
			body: JSON.stringify({ url: targetUrl }),
			signal: AbortSignal.timeout(30_000),
		})
		if (!response.ok) {
			return { text: `Web fetch failed (${response.status})`, isError: true }
		}
		const data = (await response.json()) as { excerpts?: string[] }
		if (!data.excerpts || data.excerpts.length === 0) {
			return { text: `No content could be extracted from URL: "${targetUrl}"` }
		}
		return { text: `Content from ${targetUrl}:\n\n${data.excerpts.join("\n\n")}` }
	} catch (error) {
		return { text: `Web fetch failed: ${(error as Error).message}`, isError: true }
	}
}
