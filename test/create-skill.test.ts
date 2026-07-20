import assert from "node:assert/strict"
import { test } from "node:test"

import { buildCreateSkillPrompt, CREATE_SKILL_USAGE } from "../src/commands/createSkill.js"

test("builds a repo-local skill creation prompt", () => {
	const prompt = buildCreateSkillPrompt("Review database migrations safely")

	assert.match(prompt, /<skill_request>\nReview database migrations safely\n<\/skill_request>/)
	assert.match(prompt, /\.orb\/skills\/<skill-name>\/SKILL\.md/)
	assert.match(prompt, /frontmatter containing exactly name and description/)
	assert.match(prompt, /Supporting scripts, references, and assets/)
	assert.match(prompt, /Do not create the skill in \.orbcode/)
	assert.match(prompt, /do not modify any file outside that skill directory/)
})

test("documents the required slash-command argument", () => {
	assert.equal(CREATE_SKILL_USAGE, "Usage: /create-skill <describe the repository skill you want>")
})
