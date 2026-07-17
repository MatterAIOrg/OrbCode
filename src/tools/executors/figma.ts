import { getUrlFromToken } from "../../auth/auth.js"
import type { ToolContext, ToolResult } from "../types.js"

// Calls the MatterAI backend's /axoncode/figma endpoint, which uses the
// org's configured Figma access token to fetch design data from the Figma
// REST API. The backend returns the full node tree + rendered image URLs.

interface FigmaDesignData {
	fileKey: string
	nodeId: string | null
	name: string
	lastModified: string
	thumbnailUrl: string
	nodes: Record<string, { document: unknown; components: Record<string, unknown> }>
	components: Record<string, unknown>
	styles: Record<string, unknown>
	images: Record<string, string | null>
}

interface FigmaFetchResponse {
	success: boolean
	data?: FigmaDesignData
	error?: string
}

export async function figmaFetch(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const url = String(args.url ?? "")
	if (!url) return { text: "FAILED: url is empty", isError: true }

	try {
		new URL(url)
	} catch {
		return { text: `Invalid URL format: ${url}`, isError: true }
	}

	try {
		const apiUrl = getUrlFromToken("https://api.matterai.so/axoncode/figma", context.token)
		const response = await fetch(apiUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${context.token}`,
			},
			body: JSON.stringify({ url, render_images: true, image_format: "png" }),
			signal: AbortSignal.timeout(60_000),
		})

		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as { error?: string }
			return { text: `Figma fetch failed (${response.status}): ${body.error ?? response.statusText}`, isError: true }
		}

		const data = (await response.json()) as FigmaFetchResponse
		if (!data.success || !data.data) {
			return { text: data.error ?? "Could not fetch the Figma design.", isError: true }
		}

		const d = data.data
		const imageUrls = Object.entries(d.images ?? {})
			.map(([id, u]) => `node ${id}: ${u}`)
			.join("\n")

		const resultText =
			`Figma file: ${d.name} (key: ${d.fileKey})\n` +
			`Last modified: ${d.lastModified}\n` +
			`Thumbnail: ${d.thumbnailUrl}\n` +
			`Nodes:\n` +
			JSON.stringify(d.nodes, null, 2) +
			(imageUrls ? `\n\nRendered images:\n${imageUrls}` : "")

		return { text: `Figma design data for ${url}:\n\n${resultText}` }
	} catch (error) {
		return { text: `Figma fetch failed: ${(error as Error).message}`, isError: true }
	}
}

/**
 * Extract unique Figma URLs from a block of text.
 * Matches figma.com/design/, /file/, /proto/ URLs (with or without node-id).
 */
const FIGMA_URL_REGEX = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[A-Za-z0-9]+\/[^\s"'<>]*/gi

export function extractFigmaUrls(text: string): string[] {
	if (!text) return []
	const matches = text.match(FIGMA_URL_REGEX) || []
	// Dedupe while preserving order; strip trailing punctuation
	return [...new Set(matches.map((u) => u.replace(/[.,;:!?)]+$/, "")))]
}
