import assert from "node:assert/strict"
import { test } from "node:test"

import {
	callMcpTool,
	MAX_MCP_RESULT_CHARS,
	truncateMcpResult,
	type McpConnection,
} from "../src/mcp/client.js"

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
