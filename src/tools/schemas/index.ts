import type OpenAI from "openai"

import fileEdit from "./file_edit.js"
import multiFileEdit from "./multi_file_edit.js"
import fileWrite from "./file_write.js"
import askFollowupQuestion from "./ask_followup_question.js"
import attemptCompletion from "./attempt_completion.js"
import executeCommand from "./execute_command.js"
import listFiles from "./list_files.js"
import read_file from "./read_file.js"
import searchFiles from "./search_files.js"
import updateTodoList from "./update_todo_list.js"
import useSkill from "./use_skill.js"
import figmaFetch from "./figma_fetch.js"
import webFetch from "./web_fetch.js"
import webSearch from "./web_search.js"

// Native tool schemas ported from the Orbital extension. IDE-only tools
// (codebase_search, lsp, check_past_chat_memories, browser_action, …) are not
// active in the CLI. use_skill is now active: standalone and installed-plugin
// skills are loaded by src/skills/loader.ts.
export const nativeTools = [
	fileEdit,
	multiFileEdit,
	fileWrite,
	askFollowupQuestion,
	attemptCompletion,
	executeCommand,
	listFiles,
	read_file,
	searchFiles,
	updateTodoList,
	useSkill,
	figmaFetch,
	webFetch,
	webSearch,
] satisfies OpenAI.Chat.ChatCompletionTool[]
