import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "multi_file_edit",
		description:
			"Make multiple text replacements across one or more files in a single call. Use this tool whenever you have 2 or more edits to make, even if they are all in the same file. Each edit specifies its own file_path, old_string, and new_string. Edits within the same file are applied bottom-to-top to preserve line offsets. Returns per-edit success/failure results.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				edits: {
					type: "array",
					description:
						"Array of edit operations. Each edit must have file_path, old_string, new_string. Optionally include replace_all (boolean).",
					items: {
						type: "object",
						properties: {
							file_path: {
								type: "string",
								description:
									"Absolute path to the file to modify (e.g., /Users/username/project/src/file.ts)",
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
			},
			required: ["edits"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
