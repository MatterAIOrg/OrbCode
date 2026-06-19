import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "use_skill",
		description:
			"Use a specific skill to guide the task execution. This tool applies predefined skills stored in ~/.orbcode/skills/ (user) and .orbcode/skills/ (project). Each skill is a directory containing a SKILL.md file with specialized instructions for performing specific tasks or following particular patterns. The available skills are listed in the 'Available Skills' section of your system prompt — invoke this tool with a skill_name from that list when the task matches a skill's when-to-use condition.",
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
