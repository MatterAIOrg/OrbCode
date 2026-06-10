import type OpenAI from "openai"

import { nativeTools } from "./schemas/index.js"
import type { ToolContext, ToolResult } from "./types.js"
import { fileEdit, fileWrite, multiFileEdit, readFile } from "./executors/files.js"
import { listFiles } from "./executors/listFiles.js"
import { searchFiles } from "./executors/searchFiles.js"
import { executeCommand } from "./executors/executeCommand.js"
import { webFetch, webSearch } from "./executors/web.js"

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
		case "update_todo_list":
			return "updating tasks"
		case "ask_followup_question":
			return String(args.question ?? "")
		case "attempt_completion":
			return "task complete"
		default:
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
	update_todo_list: async (args, context) => {
		context.setTodos(String(args.todos ?? ""))
		return { text: "Todo list updated." }
	},
	// ask_followup_question and attempt_completion are handled by the agent loop.
}

export async function executeTool(
	toolName: string,
	args: Record<string, unknown>,
	context: ToolContext,
): Promise<ToolResult> {
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

export function getActiveTools(): OpenAI.Chat.ChatCompletionTool[] {
	return nativeTools
}
