import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "use_skill",
		description:
			"Use a specific skill to guide the task execution. This tool allows you to apply predefined skills stored in the workspace's .agent/skills directory. Each skill contains specialized instructions for performing specific tasks or following particular patterns.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				skill_name: {
					type: "string",
					description:
						"The name of the skill to use. Must match one of the available skills listed in the tool description.",
				},
			},
			required: ["skill_name"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
