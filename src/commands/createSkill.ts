export const CREATE_SKILL_USAGE =
	"Usage: /create-skill <describe the repository skill you want>"

export function buildCreateSkillPrompt(skillRequest: string): string {
	return `Create or update a reusable skill for this repository from the user's request below.

<skill_request>
${skillRequest.trim()}
</skill_request>

All generated skill files must live under this repository path:

  .orb/skills/<skill-name>/

Do not create the skill in .orbcode, .claude, .agents, a home-directory skills folder, or anywhere else. Supporting scripts, references, and assets must also stay inside the same .orb/skills/<skill-name>/ directory. During this command, do not modify any file outside that skill directory. If the request is too ambiguous to implement safely, use ask_followup_question to ask one focused question before writing files.

Workflow:
1. Read .orb/AGENTS.md when present, inspect the relevant repository files, and check existing skills in .orb/skills so the new skill reflects this codebase and does not accidentally overwrite a different skill.
2. Derive a short, descriptive skill name using lowercase letters, digits, and hyphens only. Keep it under 64 characters and use that exact value for both the folder name and the frontmatter name.
3. Decide whether the skill needs only SKILL.md or also reusable scripts, references, or assets. Create only files that directly help execute the requested workflow repeatedly.
4. Write .orb/skills/<skill-name>/SKILL.md with YAML frontmatter containing exactly name and description. Make the description say both what the skill does and when it should be used. Write the body as concise imperative instructions for another coding agent; keep essential guidance in SKILL.md and place lengthy detail in directly linked reference files.
5. Preserve useful existing content when updating a skill. Do not create extra README, changelog, installation, or quick-reference files inside the skill.
6. Test any scripts you add. Then read the generated files back and verify the folder name, frontmatter name, description, paths, and instructions are consistent.
7. Finish by reporting the created or updated skill name, its .orb/skills path, and a short summary of what it teaches the agent.`
}
