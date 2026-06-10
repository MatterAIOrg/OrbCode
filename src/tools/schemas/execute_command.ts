import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "execute_command",
		description:
			"Run a CLI command on the user's system. Tailor the command to the environment, explain what it does, and prefer relative paths or shell-appropriate chaining. Use the cwd parameter only when directed to run in a different directory.",
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
					description: "Optional working directory for the command, relative or absolute",
				},
				message: {
					type: "string",
					description:
						"A clear, concise one-line description of what the command does, shown to the user for approval (e.g. 'Install project dependencies with npm')",
				},
				isDangerous: {
					type: "boolean",
					description:
						"Set true when the command is potentially destructive or irreversible — e.g. deletes/overwrites files (rm, mv over existing paths), force-pushes or resets git history, drops/migrates databases, changes system/network/permission state, installs globally, or sends data to external services. Set false for safe read-only or routine commands (ls, cat, build, test, install local deps). The user's selected approval mode may auto-approve only commands marked false.",
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
