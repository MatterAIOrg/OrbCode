import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import {
	callMcpTool,
	MAX_MCP_RESULT_CHARS,
	listServerTools,
	truncateMcpResult,
	type McpConnection,
} from "../src/mcp/client.js"
import { isFigmaMcpServer } from "../src/mcp/figmaGuard.js"
import { addMcpServer, loadMcpConfig } from "../src/mcp/config.js"

test("leaves MCP results within the context cap unchanged", () => {
	assert.equal(truncateMcpResult("small result"), "small result")
})

test("bounds large MCP results while retaining their beginning and end", () => {
	const input = `begin-${"x".repeat(MAX_MCP_RESULT_CHARS)}-end`
	const result = truncateMcpResult(input)

	assert.equal(result.length, MAX_MCP_RESULT_CHARS)
	assert.match(result, /^begin-/)
	assert.match(result, /MCP tool result truncated by OrbCode/)
	assert.match(result, /-end$/)
})

test("caps text returned by an MCP tool before handing it to the agent", async () => {
	const connection = {
		client: {
			callTool: async () => ({
				content: [{ type: "text", text: "x".repeat(MAX_MCP_RESULT_CHARS + 1_000) }],
			}),
		},
	} as unknown as McpConnection

	const result = await callMcpTool(connection, "large_result", {})

	assert.equal(result.text.length, MAX_MCP_RESULT_CHARS)
	assert.match(result.text, /MCP tool result truncated by OrbCode/)
})

test("identifies Figma MCP servers by name, endpoint, package, or credential name", () => {
	assert.equal(isFigmaMcpServer("figma", { type: "http", url: "https://example.com/mcp" }), true)
	assert.equal(isFigmaMcpServer("design", { type: "http", url: "https://mcp.figma.com/mcp" }), true)
	assert.equal(isFigmaMcpServer("design", { type: "http", url: "http://127.0.0.1:3845/mcp" }), true)
	assert.equal(isFigmaMcpServer("design", { command: "npx", args: ["figma-developer-mcp"] }), true)
	assert.equal(isFigmaMcpServer("design", { command: "node", env: { FIGMA_TOKEN: "secret" } }), true)
	assert.equal(isFigmaMcpServer("design", { command: "node", env: { MCP_URL: "https://mcp.figma.com/mcp" } }), true)
	assert.equal(isFigmaMcpServer("github", { type: "http", url: "https://api.github.com/mcp" }), false)
})

test("filters Figma MCPs from project config and rejects CLI additions", () => {
	const project = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-figma-mcp-test-"))
	try {
		fs.writeFileSync(
			path.join(project, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					renamed_design_test: { type: "http", url: "http://127.0.0.1:3845/mcp" },
					unrelated_test_server: { type: "http", url: "https://api.github.com/mcp" },
				},
			}),
		)

		const { servers } = loadMcpConfig(project)
		assert.equal(servers.renamed_design_test, undefined)
		assert.equal(servers.unrelated_test_server?.type, "http")
		assert.throws(
			() => addMcpServer(project, "figma", { type: "http", url: "https://mcp.figma.com/mcp" }, "project"),
			/native figma_fetch/,
		)
	} finally {
		fs.rmSync(project, { recursive: true, force: true })
	}
})

test("does not expose Figma-specific tools from general MCP servers", async () => {
	const client = {
		listTools: async () => ({
			tools: [
				{ name: "get_design", description: "Read a Figma frame", inputSchema: { type: "object" } },
				{ name: "search_issues", description: "Search issues", inputSchema: { type: "object" } },
			],
		}),
	} as never

	const tools = await listServerTools("general", client)
	assert.deepEqual(tools.map((tool) => tool.originalName), ["search_issues"])
})
