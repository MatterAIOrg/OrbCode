import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "web_fetch",
		description:
			"Fetch a web page as cleaned markdown. Long pages are cut to a budget: pass a prompt describing what you need and only the most relevant sections are returned; without one you get the top of the page.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description: "The URL to fetch content from",
				},
				prompt: {
					type: ["string", "null"],
					description:
						"What you are looking for on the page, e.g. 'rate limits for the batch API'. Null to read the page from the top",
				},
			},
			required: ["url", "prompt"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
