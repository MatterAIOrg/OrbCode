import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "file_edit",
		description:
			"Make exactly ONE text replacement in ONE file. DO NOT call this tool multiple times in sequence — if you have 2 or more edits, you MUST use multi_file_edit instead. Provide the current text (`old_string`) and the desired text (`new_string`). By default only a single uniquely matched occurrence is replaced; set `replace_all` to true to update every matching occurrence. old_string and new_string cannot be the same.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file to modify (e.g., /Users/username/project/src/file.ts)",
				},
				old_string: {
					type: "string",
					description:
						"Exact text to replace. Provide enough context for a unique match. Use an empty string to replace the entire file.",
				},
				new_string: {
					type: "string",
					description:
						"Replacement text. This will be inserted in place of the matched section. Can be an empty string to delete the match.",
				},
				replace_all: {
					type: "boolean",
					description:
						"Set to true to replace every occurrence of the matched text. Defaults to false (replace a single uniquely identified occurrence).",
				},
			},
			required: ["file_path", "old_string", "new_string"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
