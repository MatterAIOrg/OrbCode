import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "check_past_chat_memories",
		description:
			"Search through previous chat completion results to find relevant context from past tasks. Use this when you need to recall what was implemented or fixed in previous chats.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				regex: {
					type: "string",
					description: "Regular expression pattern to search memory contents",
				},
				workspace: {
					type: "string",
					description: "Filter by workspace directory (optional, defaults to current workspace)",
				},
			},
			required: ["regex"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
