import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "web_search",
		description:
			"Search the web for information using a query. Returns a list of relevant results with URLs, titles, publish dates, and excerpts. Use this when you need to find specific information on the web.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "The search query to find information on the web",
				},
			},
			required: ["query"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
