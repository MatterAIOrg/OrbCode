import { spawn } from "node:child_process"

import { getShell, getShellRunArgs, isCmdShell } from "../../utils/shell.js"
import { type ToolContext, type ToolResult, resolveWorkspacePath } from "../types.js"

const COMMAND_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 30_000

export async function executeCommand(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
	const command = String(args.command ?? "").trim()
	if (!command) {
		return { text: "FAILED: command is empty", isError: true }
	}
	const cwd = args.cwd ? resolveWorkspacePath(context.cwd, String(args.cwd)) : context.cwd

	if (context.signal?.aborted) return { text: "Command not run: the turn was interrupted.", isError: true }

	return new Promise<ToolResult>((resolve) => {
		const isWindows = process.platform === "win32"
		const child = spawn(getShell(), getShellRunArgs(command), {
			cwd,
			env: { ...process.env, TERM: "dumb" },
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group, so a timeout/interrupt can kill grandchildren too
			// (`find /` started by the shell would otherwise outlive the shell and
			// keep the output pipes open).
			detached: !isWindows,
			// cmd.exe parses the command string itself; pre-quoting would corrupt it.
			windowsVerbatimArguments: isWindows && isCmdShell(),
		})

		let output = ""
		let truncated = false
		let stopReason: "timeout" | "interrupted" | undefined
		let settled = false
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

		const killTree = (signal: NodeJS.Signals) => {
			try {
				if (!isWindows && child.pid) process.kill(-child.pid, signal)
				else child.kill(signal)
			} catch {
				// already gone
			}
		}
		const finish = (result: ToolResult) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			clearTimeout(forceTimer)
			context.signal?.removeEventListener("abort", onAbort)
			resolve(result)
		}
		let forceTimer: NodeJS.Timeout | undefined
		const stop = (reason: "timeout" | "interrupted") => {
			if (stopReason) return
			stopReason = reason
			killTree("SIGTERM")
			forceTimer = setTimeout(() => {
				killTree("SIGKILL")
				// Something may still hold the pipes; don't wait on it.
				child.stdout.destroy()
				child.stderr.destroy()
				finish(stoppedResult())
			}, 2000)
		}
		const stoppedResult = (): ToolResult => {
			let text = output.trim() || "(no output)"
			if (truncated) text += `\n\n(Output truncated at ${MAX_OUTPUT_CHARS} characters.)`
			text +=
				stopReason === "interrupted"
					? "\n\nCommand stopped: the user interrupted the turn."
					: `\n\nCommand killed after the ${COMMAND_TIMEOUT_MS / 1000}s timeout. Scope it more narrowly (e.g. search the workspace, not / or the home directory) or ask the user to run it.`
			return { text, isError: true }
		}
		const onAbort = () => stop("interrupted")
		context.signal?.addEventListener("abort", onAbort, { once: true })
		const timer = setTimeout(() => stop("timeout"), COMMAND_TIMEOUT_MS)

		child.on("error", (error) => {
			finish({ text: `FAILED to start command: ${error.message}`, isError: true })
		})

		child.on("close", (code, signal) => {
			if (stopReason) {
				finish(stoppedResult())
				return
			}
			let text = output.trim() || "(no output)"
			if (truncated) text += `\n\n(Output truncated at ${MAX_OUTPUT_CHARS} characters.)`
			text += signal ? `\n\nCommand terminated by signal ${signal}.` : `\n\nExit code: ${code}`
			finish({ text, isError: code !== 0 && code !== null })
		})
	})
}
