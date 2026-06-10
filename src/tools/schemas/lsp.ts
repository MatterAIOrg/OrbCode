import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "lsp",
		description: `Interact with Language Server Protocol (LSP) servers to get code intelligence features like go-to-definition, find-references, hover information, and symbol search.

Supported operations:
- go_to_definition: Find where a symbol is defined
- find_references: Find all references to a symbol across the codebase
- hover: Get hover information (documentation, type info) for a symbol
- document_symbol: Get all symbols (functions, classes, variables) in a document
- workspace_symbol: Search for symbols across the entire workspace

All operations require:
- file_path: The absolute path to the file to operate on
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

Note: LSP servers must be configured for the file type. If no server is available, an error will be returned.`,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				operation: {
					type: "string",
					description: "The LSP operation to perform",
					enum: ["go_to_definition", "find_references", "hover", "document_symbol", "workspace_symbol"],
				},
				file_path: {
					type: "string",
					description: "The absolute path to the file to operate on",
				},
				line: {
					type: "number",
					description: "The line number (1-based, as shown in editors)",
				},
				character: {
					type: "number",
					description: "The character offset (1-based, as shown in editors)",
				},
			},
			required: ["operation", "file_path", "line", "character"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
