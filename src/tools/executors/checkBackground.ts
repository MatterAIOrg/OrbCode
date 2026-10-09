import { getBackgroundCommand } from "./backgroundCommands.js"
import { type ToolContext, type ToolResult } from "../types.js"

const MAX_OUTPUT_CHARS = 30_000

function formatOutput(output: string): string {
	const trimmed = output.trim()
	if (!trimmed) return "  Output: (empty)"
	if (trimmed.length > MAX_OUTPUT_CHARS) {
		return `  Output (truncated):\n${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n... (output truncated)`
	}
	return `  Output:\n${trimmed}`
}

export async function checkBackground(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const id = String(args.id ?? "").trim()
	if (!id) {
		return { text: "FAILED: id is required", isError: true }
	}

	const cmd = getBackgroundCommand(id)
	if (!cmd) {
		return { text: `FAILED: No background command found with id "${id}"`, isError: true }
	}

	const elapsed = Math.round((Date.now() - cmd.startedAt) / 1000)
	const duration = cmd.endedAt ? Math.round((cmd.endedAt - cmd.startedAt) / 1000) : null

	let text = `Background command status:\n`
	text += `  ID: ${cmd.id}\n`
	text += `  Command: ${cmd.command}\n`
	text += `  Status: ${cmd.status}\n`
	text += `  Elapsed: ${elapsed}s`
	if (duration !== null) {
		text += ` (duration: ${duration}s)`
	}
	text += `\n`

	if (cmd.status !== "running") {
		// The agent has now seen the result; skip the next-turn completion notice.
		cmd.reported = true
		text += `  Exit code: ${cmd.exitCode === null ? "unknown" : cmd.exitCode}\n`
		text += formatOutput(cmd.output)
	} else {
		text += `  Still running...`
		if (cmd.output.trim()) {
			text += `\n  Partial output:\n${cmd.output.trim()}`
		}
	}

	return { text }
}
