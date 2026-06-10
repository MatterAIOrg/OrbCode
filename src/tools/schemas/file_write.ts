import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "file_write",
		description:
			"Create a new file that does not exists yet or overwrite a file with all the new content. Use this tool to write new files or completely rewrite existing files. The tool will create missing directories automatically. For partial edits to existing files, you will only use file_edit tool instead.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				file_path: {
					type: "string",
					description: "Absolute path to the file to write (e.g., /Users/username/project/src/file.ts)",
				},
				content: {
					type: "string",
					description:
						"Full content to write to the file. For new files, this is the complete file content. For existing files, this will replace the entire file content. Use actual newlines for line breaks; JSON escape sequences are handled automatically.",
				},
				line_count: {
					type: "integer",
					description:
						"Total number of lines in the content, counting blank lines. Used to verify content completeness.",
				},
			},
			required: ["file_path", "content", "line_count"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
