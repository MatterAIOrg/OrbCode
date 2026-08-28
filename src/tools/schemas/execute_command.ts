import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "execute_command",
		description:
			"Run one CLI command. Provide a short user-facing message and explicitly classify whether it may modify or delete data. Prefer commands scoped to the workspace.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				command: {
					type: "string",
					description: "Shell command to execute",
				},
			cwd: {
				type: ["string", "null"],
				description: "Working directory, or null for the workspace directory",
			},
			message: {
				type: "string",
				description: "Clear one-line description shown to the user for approval",
			},
				isDangerous: {
					type: "boolean",
					description:
						"Set true when the command is potentially destructive or irreversible — e.g. deletes/overwrites files (rm, mv over existing paths), force-pushes or resets git history, drops/migrates databases, changes system/network/permission state, installs globally, or sends data to external services. Set false for safe read-only or routine commands (ls, cat, build, test, install local deps). The user's selected approval mode may auto-approve only commands marked false.",
				},
			},
			required: ["command", "cwd", "message", "isDangerous"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
