import type OpenAI from "openai"

export const read_file_single = {
	type: "function",
	function: {
		name: "read_file",
		description:
			"Read a file and return its contents with line numbers. Use offset and limit to read specific portions efficiently. Default and maximum limit is 1000 lines to prevent context overflow.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file to read (e.g., /Users/username/project/src/file.ts)",
				},
				offset: {
					type: ["number", "null"],
					description: "Starting line number (1-indexed). Defaults to 1 if not specified.",
				},
				limit: {
					type: ["number", "null"],
					description:
						"Maximum number of lines to read from offset. Default and maximum limit is 1000 lines.",
				},
			},
			required: ["file_path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
