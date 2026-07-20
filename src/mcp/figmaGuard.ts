const FIGMA_MARKER = /figma/i
const FIGMA_DESKTOP_ENDPOINT = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):3845(?:\/|$)/i

/**
 * OrbCode provides Figma access through its native `figma_fetch` tool. An
 * external Figma MCP must never be loaded because it could bypass or compete
 * with that native integration.
 */
export function isFigmaMcpServer(name: string, config: unknown): boolean {
	if (FIGMA_MARKER.test(name)) return true
	if (!config || typeof config !== "object") return false

	const candidate = config as Record<string, unknown>
	if (typeof candidate.url === "string" && FIGMA_DESKTOP_ENDPOINT.test(candidate.url)) return true
	const identityParts: unknown[] = [candidate.command, candidate.url, candidate.args]
	for (const field of [candidate.env, candidate.headers]) {
		if (field && typeof field === "object" && !Array.isArray(field)) {
			identityParts.push(Object.entries(field as Record<string, unknown>).flat())
		}
	}

	return identityParts.flat(2).some((value) => typeof value === "string" && FIGMA_MARKER.test(value))
}

/** Block Figma-specific functions exposed by an otherwise general MCP server. */
export function isFigmaMcpTool(tool: { name?: string; description?: string }): boolean {
	return [tool.name, tool.description].some(
		(value) => typeof value === "string" && FIGMA_MARKER.test(value),
	)
}
