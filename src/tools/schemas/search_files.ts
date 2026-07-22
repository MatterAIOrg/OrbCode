import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "search_files",
		description:
			"Search file contents recursively under a directory using a Rust-compatible regex and optional file glob. Returns a compact, paginated page with at most three matches per file; use context_lines 0 for discovery, then read the relevant file. Continue only with the opaque cursor returned by the same path, regex, and file_pattern; pass JSON null without quotes for the first page. If Next cursor is none, the search is complete: stop and never pass the word none. A rare FFF continuation failure may restart with ripgrep and is marked Restarted: yes.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: "Directory to search recursively, relative to the workspace",
				},
				regex: {
					type: "string",
					minLength: 1,
					description: "Rust-compatible regular expression pattern to match",
				},
				file_pattern: {
					type: ["string", "null"],
					description: "Glob limiting searched files (e.g. '*.ts'), or null for all files",
				},
				cursor: {
					type: ["string", "null"],
					description:
						"Opaque continuation cursor copied exactly from a previous identical search, or JSON null for the first page",
				},
				max_results: {
					type: ["integer", "null"],
					minimum: 1,
					maximum: 100,
					description: "Target results for this page; null uses 50",
				},
				context_lines: {
					type: ["integer", "null"],
					minimum: 0,
					maximum: 2,
					description: "Context lines before and after each match; null uses 0",
				},
			},
			required: ["path", "regex", "file_pattern", "cursor", "max_results", "context_lines"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
