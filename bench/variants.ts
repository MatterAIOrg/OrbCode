import { buildSystemPrompt } from "../src/prompts/system.js"

/** Remove a markdown section: from its heading line up to the next heading of any level. */
function removeSection(text: string, heading: string): string {
	const start = text.indexOf(`\n${heading}\n`)
	if (start < 0) throw new Error(`section not found: ${heading}`)
	const rest = text.slice(start + heading.length + 2)
	const next = rest.search(/\n#{1,3} /)
	return text.slice(0, start) + (next < 0 ? "" : rest.slice(next))
}

const WORKING_STYLE = `
## Working style

- Act directly. As soon as you know what to change, make the edit — do not write out plans or re-derive facts you already have.
- Simple requests (rename, small edit, one-line fix) need only: locate, edit, run the relevant check once.
- Batch independent reads and searches into one step; issue edits and the follow-up check together when the check does not depend on reading the edit result.
- If a call fails or a result looks wrong, fix the call and move on. Never repeat an identical call more than twice.
`

export const VARIANTS: Record<string, (cwd: string) => string> = {
	/** Ablation: drop the deliberation-ritual sections, add a short action-oriented block. */
	lean: (cwd) => {
		let prompt = buildSystemPrompt(cwd)
		for (const heading of [
			"## Verifying tool results and avoiding loops",
			"## Plan before editing",
			"## Investigation efficiency",
		]) {
			prompt = removeSection(prompt, heading)
		}
		return prompt.replace("\n## update_todo_list\n", `${WORKING_STYLE}\n## update_todo_list\n`)
	},
}
