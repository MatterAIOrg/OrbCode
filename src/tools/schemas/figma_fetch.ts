import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "figma_fetch",
		description:
			"Fetch design data from a Figma URL. Returns the complete node tree (layout, styles, text content, nested children, components) and rendered image URLs for the file or a specific frame. Use this whenever the user shares a Figma link and wants design context, code generation from a design, or analysis of a Figma frame.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				url: {
					type: "string",
					description:
						"The full Figma URL, e.g. https://www.figma.com/design/<key>/<title>?node-id=1-2",
				},
			},
			required: ["url"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
