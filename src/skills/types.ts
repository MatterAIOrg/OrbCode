/** A loaded skill (markdown prompt with frontmatter metadata). */
export interface Skill {
	/** Skill name (the directory name under skills/). */
	name: string
	/** Human-readable description, from frontmatter or the first paragraph. */
	description: string
	/** When the model should invoke this skill (frontmatter `when_to_use`). */
	whenToUse?: string
	/** The full markdown body (without frontmatter). */
	content: string
	/** Where this skill was loaded from. */
	source: "user" | "project" | "plugin" | "external"
	/** Absolute path to the skill's directory (for ${SKILL_DIR} substitution). */
	dir: string
	/** Plugin namespace/root when this skill was installed as part of a plugin. */
	plugin?: string
	pluginDir?: string
}

/** Minimal frontmatter parser: extracts a top-level YAML block + the body. */
export interface ParsedFrontmatter {
	frontmatter: Record<string, string>
	content: string
}
