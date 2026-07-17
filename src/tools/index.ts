import type OpenAI from "openai"

import { nativeTools } from "./schemas/index.js"
import type { ToolContext, ToolResult } from "./types.js"
import { fileEdit, fileWrite, multiFileEdit, readFile } from "./executors/files.js"
import { listFiles } from "./executors/listFiles.js"
import { searchFiles } from "./executors/searchFiles.js"
import { executeCommand } from "./executors/executeCommand.js"
import { useSkill } from "./executors/skills.js"
import { webFetch, webSearch } from "./executors/web.js"
import { figmaFetch } from "./executors/figma.js"
import type { McpManager } from "../mcp/manager.js"

export { nativeTools }
export type { ToolContext, ToolResult }

export type ApprovalKind = "none" | "edit" | "command"

/** Tools that modify the user's system and need approval before running. */
export function getApprovalKind(toolName: string, args: Record<string, unknown>): ApprovalKind {
	switch (toolName) {
		case "file_edit":
		case "multi_file_edit":
		case "file_write":
			return "edit"
		case "execute_command":
			return "command"
		default:
			return "none"
	}
}

/** One-line human summary of a tool call, shown in the UI. */
export function describeToolCall(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "read_file":
			return String(args.file_path ?? "")
		case "file_write":
			return String(args.file_path ?? "")
		case "file_edit":
			return String(args.file_path ?? "")
		case "multi_file_edit": {
			const edits = Array.isArray(args.edits) ? args.edits : []
			const files = [...new Set(edits.map((e: { file_path?: string }) => e.file_path ?? ""))]
			return `${edits.length} edits in ${files.length} file${files.length === 1 ? "" : "s"}`
		}
		case "execute_command":
			return String(args.command ?? "")
		case "list_files":
			return `${args.path ?? "."}${args.recursive ? " (recursive)" : ""}`
		case "search_files":
			return `/${args.regex ?? ""}/ in ${args.path ?? "."}${args.file_pattern ? ` (${args.file_pattern})` : ""}`
		case "web_search":
			return String(args.query ?? "")
		case "web_fetch":
			return String(args.url ?? "")
		case "figma_fetch":
			return String(args.url ?? "")
		case "update_todo_list":
			return "updating tasks"
		case "use_skill":
			return String(args.skill_name ?? "")
		case "ask_followup_question":
			return String(args.question ?? "")
		case "attempt_completion":
			return "task complete"
		default:
			// MCP tools (mcp__<server>__<tool>) — show the server + tool name.
			if (/^mcp__/.test(toolName)) {
				const match = /^mcp__([^_]+)__(.+)$/.exec(toolName)
				return match ? `${match[2]} (${match[1]})` : toolName
			}
			return toolName
	}
}

const executors: Record<string, (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>> = {
	read_file: readFile,
	file_write: fileWrite,
	file_edit: fileEdit,
	multi_file_edit: multiFileEdit,
	list_files: listFiles,
	search_files: searchFiles,
	execute_command: executeCommand,
	web_search: webSearch,
	web_fetch: webFetch,
	figma_fetch: figmaFetch,
	use_skill: useSkill,
	update_todo_list: async (args, context) => {
		context.setTodos(String(args.todos ?? ""))
		return { text: "Todo list updated." }
	},
	// ask_followup_question and attempt_completion are handled by the agent loop.
	// MCP tools (mcp__<server>__<tool>) are routed via the McpManager in executeTool.
}

export async function executeTool(
	toolName: string,
	args: Record<string, unknown>,
	context: ToolContext,
	mcp?: McpManager,
): Promise<ToolResult> {
	// MCP tools are namespaced as mcp__<server>__<tool> and routed to the manager.
	if (mcp && mcp.hasTool(toolName)) {
		const result = await mcp.callTool(toolName, args)
		return { text: result.text, isError: result.isError }
	}
	const executor = executors[toolName]
	if (!executor) {
		return { text: `Tool "${toolName}" is not available in OrbCode CLI.`, isError: true }
	}
	try {
		return await executor(args, context)
	} catch (error) {
		return { text: `Tool ${toolName} failed: ${(error as Error).message}`, isError: true }
	}
}

/** Native tools plus any MCP tools from connected servers. */
export function getActiveTools(mcp?: McpManager): OpenAI.Chat.ChatCompletionTool[] {
	const tools: OpenAI.Chat.ChatCompletionTool[] = [...nativeTools]
	if (mcp) tools.push(...mcp.getTools())
	return tools
}
