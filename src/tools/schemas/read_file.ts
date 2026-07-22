import type OpenAI from "openai"

export const read_file = {
	type: "function",
	function: {
		name: "read_file",
		description:
			"Read one or more files and return line-numbered contents. Batch every independent file or region needed for the current investigation into this single call. Prefer 200-1000 lines per source-code region; for files up to 1000 lines, omit offset and limit to read the file once. Do not walk adjacent regions through many small calls. Each requested region is capped at 1000 lines.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				files: {
					type: "array",
					minItems: 1,
					maxItems: 10,
					description:
						"File regions to read together. Include all independent reads already known at this step. The same file may appear more than once for distant regions.",
					items: {
						type: "object",
						properties: {
							file_path: {
								type: "string",
								description: "Absolute path to the file (e.g., /Users/username/project/src/file.ts).",
							},
							offset: {
								type: ["number", "null"],
								minimum: 1,
								description:
									"Starting line number (1-indexed). Use it only when targeting a region in a file longer than 1000 lines; otherwise use null.",
							},
							limit: {
								type: ["number", "null"],
								minimum: 200,
								maximum: 1000,
								description:
									"Lines to read from offset. Prefer 500-1000. Use null to read from offset up to the 1000-line cap.",
							},
						},
						required: ["file_path"],
						additionalProperties: false,
					},
				},
			},
			required: ["files"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

export const read_file_single = read_file

export default read_file

