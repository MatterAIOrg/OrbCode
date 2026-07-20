import type { ToolContext, ToolResult } from "../types.js"
import { loadSkillFromPath, loadSkills, renderSkillContent } from "../../skills/loader.js"

/**
 * `use_skill` executor: loads a skill's full markdown instructions and returns
 * them to the model so it can follow the skill's guidance for the current task.
 *
 * Skills are discovered from standalone skill directories and installed
 * plugin bundles (see the skills loader). The model sees the catalog in the
 * system prompt and invokes this tool with a discovered name or explicit path.
 */
export async function useSkill(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const skillName = String(args.skill_name ?? "").trim()
	if (!skillName) {
		return { text: "No skill_name provided.", isError: true }
	}
	const skills = loadSkills(context.cwd)
	const skill = skills.get(skillName) ?? loadSkillFromPath(skillName, context.cwd)
	if (!skill) {
		const available = [...skills.keys()].join(", ") || "(none)"
		return {
			text: `Skill "${skillName}" not found or invalid. Use a listed skill name or a path to a skill directory or SKILL.md file. Available skills: ${available}`,
			isError: true,
		}
	}
	const content = renderSkillContent(skill)
	return {
		text: `# Skill: ${skill.name}\n\n${content}\n\n---\nFollow this skill's instructions for the current task.`,
	}
}
