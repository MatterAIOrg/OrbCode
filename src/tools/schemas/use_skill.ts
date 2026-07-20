import type OpenAI from "openai"

export default {
	type: "function",
	function: {
		name: "use_skill",
		description:
			"Use a skill by its discovered name or by an explicit skill directory or SKILL.md path. Skills can be standalone user/project skills, external path-based skills, or namespaced skills installed as part of a plugin bundle.",
		strict: true,
		parameters: {
			type: "object",
			properties: {
				skill_name: {
					type: "string",
					description:
						"A discovered skill name, plugin:skill name, or an absolute, workspace-relative, or home-relative path to a skill directory or SKILL.md file.",
				},
			},
			required: ["skill_name"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
