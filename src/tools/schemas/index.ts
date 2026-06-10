import type OpenAI from "openai"

import fileEdit from "./file_edit.js"
import multiFileEdit from "./multi_file_edit.js"
import fileWrite from "./file_write.js"
import askFollowupQuestion from "./ask_followup_question.js"
import attemptCompletion from "./attempt_completion.js"
import executeCommand from "./execute_command.js"
import listFiles from "./list_files.js"
import { read_file_single } from "./read_file.js"
import searchFiles from "./search_files.js"
import updateTodoList from "./update_todo_list.js"
import webFetch from "./web_fetch.js"
import webSearch from "./web_search.js"

// Native tool schemas ported verbatim from the Orbital extension (native-tools).
// Tools that depend on IDE-only services (codebase_search, lsp, use_skill,
// check_past_chat_memories, browser_action, …) are not active in the CLI.
export const nativeTools = [
	fileEdit,
	multiFileEdit,
	fileWrite,
	askFollowupQuestion,
	attemptCompletion,
	executeCommand,
	listFiles,
	read_file_single,
	searchFiles,
	updateTodoList,
	webFetch,
	webSearch,
] satisfies OpenAI.Chat.ChatCompletionTool[]
