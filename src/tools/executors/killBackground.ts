import { getBackgroundCommand, killBackgroundCommand } from "./backgroundCommands.js"
import { type ToolContext, type ToolResult } from "../types.js"

export async function killBackground(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const id = String(args.id ?? "").trim()
	if (!id) {
		return { text: "FAILED: id is required", isError: true }
	}

	const cmd = getBackgroundCommand(id)
	if (!cmd) {
		return { text: `FAILED: No background command found with id "${id}"`, isError: true }
	}
	if (cmd.status !== "running") {
		return { text: `Background command ${id} is not running (status: ${cmd.status}).` }
	}

	const killed = killBackgroundCommand(id)
	if (!killed) {
		return { text: `FAILED: could not kill background command ${id} (process may have already exited).`, isError: true }
	}
	return { text: `Sent SIGTERM to background command ${id} (pid ${cmd.pid}). It is force-killed if still running after 3s.` }
}
