import type OpenAI from "openai"

import fileEdit from "./file_edit.js"
import multiFileEdit from "./multi_file_edit.js"
import fileWrite from "./file_write.js"
import askFollowupQuestion from "./ask_followup_question.js"
import attemptCompletion from "./attempt_completion.js"
import bash from "./bash.js"
import read_file from "./read_file.js"
import updateTodoList from "./update_todo_list.js"
import useSkill from "./use_skill.js"
import figmaFetch from "./figma_fetch.js"
import webFetch from "./web_fetch.js"
import webSearch from "./web_search.js"
import checkBackground from "./check_background.js"
import killBackground from "./kill_background.js"

// Native tool schemas ported from the Orbital extension. File discovery and
// content search (list_files, search_files) are deliberately not exposed: the
// model uses rg/find/ls through the Bash tool, and read-only commands skip
// the approval prompt (see tools/readOnlyCommand.ts). IDE-only tools
// (codebase_search, lsp, check_past_chat_memories, browser_action, …) are not
// active in the CLI. use_skill is now active: standalone and installed-plugin
// skills are loaded by src/skills/loader.ts.
export const nativeTools = [
	fileEdit,
	multiFileEdit,
	fileWrite,
	askFollowupQuestion,
	attemptCompletion,
	bash,
	read_file,
	updateTodoList,
	useSkill,
	figmaFetch,
	webFetch,
	webSearch,
	checkBackground,
	killBackground,
] satisfies OpenAI.Chat.ChatCompletionTool[]
