import { spawn } from "node:child_process"

import { getShell, getShellRunArgs } from "../../utils/shell.js"
import { type ToolContext, type ToolResult, resolveWorkspacePath } from "../types.js"

const COMMAND_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 30_000

export async function executeCommand(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const command = String(args.command ?? "").trim()
	if (!command) {
		return { text: "FAILED: command is empty", isError: true }
	}
	const cwd = args.cwd ? resolveWorkspacePath(context.cwd, String(args.cwd)) : context.cwd

	return new Promise<ToolResult>((resolve) => {
		const child = spawn(getShell(), getShellRunArgs(command), {
			cwd,
			env: { ...process.env, TERM: "dumb" },
			stdio: ["ignore", "pipe", "pipe"],
			// cmd.exe parses the command string itself; pre-quoting would corrupt it.
			windowsVerbatimArguments: process.platform === "win32",
		})

		let output = ""
		let truncated = false
		const append = (data: Buffer) => {
			if (output.length < MAX_OUTPUT_CHARS) {
				output += data.toString()
				if (output.length >= MAX_OUTPUT_CHARS) {
					output = output.slice(0, MAX_OUTPUT_CHARS)
					truncated = true
				}
			} else {
				truncated = true
			}
		}
		child.stdout.on("data", append)
		child.stderr.on("data", append)

		const timer = setTimeout(() => {
			child.kill("SIGTERM")
			setTimeout(() => child.kill("SIGKILL"), 3000)
		}, COMMAND_TIMEOUT_MS)

		child.on("error", (error) => {
			clearTimeout(timer)
			resolve({ text: `FAILED to start command: ${error.message}`, isError: true })
		})

		child.on("close", (code, signal) => {
			clearTimeout(timer)
			let text = output.trim() || "(no output)"
			if (truncated) text += `\n\n(Output truncated at ${MAX_OUTPUT_CHARS} characters.)`
			if (signal) {
				text += `\n\nCommand terminated by signal ${signal} (timeout is ${COMMAND_TIMEOUT_MS / 1000}s).`
			} else {
				text += `\n\nExit code: ${code}`
			}
			resolve({ text, isError: code !== 0 && code !== null })
		})
	})
}
