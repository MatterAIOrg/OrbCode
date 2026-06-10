import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "web_fetch",
		description:
			"Fetch content from a URL using curl. Use this when you need to scrape or retrieve content from a web page. Returns the raw HTML/text content from the URL.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "The URL to fetch content from",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
