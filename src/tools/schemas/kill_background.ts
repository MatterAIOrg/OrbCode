import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "kill_background",
		description:
			"Stop a background command started with Bash(background=true) by sending SIGTERM to its process group. Use this when a background command is no longer needed or is misbehaving. Confirm with check_background afterwards.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				id: {
					type: "string",
					description: "The background command ID returned when the command was started",
				},
			},
			required: ["id"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
