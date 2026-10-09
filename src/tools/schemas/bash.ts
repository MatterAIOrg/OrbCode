import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "Bash",
		description:
			"Run one bash command. Provide a short user-facing message and explicitly classify whether it may modify or delete data. Prefer commands scoped to the workspace. For long-running commands (downloads, builds, tests), set background to true to run them asynchronously and check status later with check_background.",
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
				background: {
					type: "boolean",
					description:
						"Set true to run the command in the background (non-blocking). The command runs asynchronously and you can check its status later with the check_background tool. Use for long-running commands like downloads, builds, or tests. The command's output is captured to a temp file and available when you check status.",
				},
			},
			required: ["command", "cwd", "message", "isDangerous"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
