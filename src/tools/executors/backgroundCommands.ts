import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface BackgroundCommand {
	id: string
	/** Task that started the command; scopes listing, notices and cleanup. */
	owner: string | undefined
	command: string
	cwd: string
	pid: number | null
	status: "running" | "completed" | "failed" | "killed"
	exitCode: number | null
	output: string
	outputFile: string
	startedAt: number
	endedAt: number | null
	/** Set once the agent has been told this command finished. */
	reported: boolean
}

/** Completed commands are pruned (and their temp files deleted) after this long. */
const RETENTION_MS = 60 * 60 * 1000

/** Grace period between SIGTERM and SIGKILL when stopping a command. */
const KILL_GRACE_MS = 3000

const commands = new Map<string, BackgroundCommand>()
const listeners = new Set<() => void>()
let exitHookInstalled = false

/** Subscribe to start/finish/kill events. Returns an unsubscribe function. */
export function subscribeBackgroundCommands(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function notify() {
	for (const listener of listeners) {
		try {
			listener()
		} catch {
			// a broken listener must not affect the registry
		}
	}
}

function signalCommand(cmd: BackgroundCommand, signal: NodeJS.Signals): boolean {
	if (!cmd.pid) return false
	try {
		// Negative pid targets the whole process group (detached spawn).
		process.kill(process.platform !== "win32" ? -cmd.pid : cmd.pid, signal)
		return true
	} catch {
		return false
	}
}

/** Detached children outlive us by default; take them down when we exit. */
function installExitHook() {
	if (exitHookInstalled) return
	exitHookInstalled = true
	process.once("exit", () => {
		for (const cmd of commands.values()) {
			if (cmd.status === "running") signalCommand(cmd, "SIGTERM")
		}
	})
}

function readOutput(cmd: BackgroundCommand): string {
	try {
		return fs.readFileSync(cmd.outputFile, "utf-8")
	} catch {
		return cmd.output
	}
}

function deleteOutputFile(cmd: BackgroundCommand) {
	try {
		fs.rmSync(cmd.outputFile, { force: true })
	} catch {
		// best-effort cleanup
	}
}

/** Drop finished commands older than the retention window, along with their temp files. */
function pruneExpired() {
	const now = Date.now()
	for (const [id, cmd] of commands) {
		if (cmd.status !== "running" && cmd.endedAt !== null && now - cmd.endedAt > RETENTION_MS) {
			deleteOutputFile(cmd)
			commands.delete(id)
		}
	}
}

export function startBackgroundCommand(
	command: string,
	cwd: string,
	shell: string,
	shellArgs: string[],
	owner?: string,
): BackgroundCommand {
	pruneExpired()
	installExitHook()

	const id = `bg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
	const outputFile = path.join(os.tmpdir(), `orbcode-bg-${id}.log`)

	const bgCommand: BackgroundCommand = {
		id,
		owner,
		command,
		cwd,
		pid: null,
		status: "running",
		exitCode: null,
		output: "",
		outputFile,
		startedAt: Date.now(),
		endedAt: null,
		reported: false,
	}
	commands.set(id, bgCommand)

	const child = spawn(shell, shellArgs, {
		cwd,
		env: { ...process.env, TERM: "dumb" },
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	})

	bgCommand.pid = child.pid ?? null

	// Output is captured to a temp file so it survives partial reads while running.
	const outStream = fs.createWriteStream(outputFile)
	child.stdout.on("data", (data) => outStream.write(data))
	child.stderr.on("data", (data) => outStream.write(data))

	// Finalize status only after the stream has flushed, so a concurrent
	// getBackgroundCommand never sees a finished status with a stale file.
	// A spawn failure emits both "error" and "close"; the first one wins.
	let finalized = false
	const finalize = (status: BackgroundCommand["status"], exitCode: number | null) => {
		if (finalized) return
		finalized = true
		outStream.end(() => {
			bgCommand.exitCode = exitCode
			bgCommand.status = status
			bgCommand.endedAt = Date.now()
			notify()
		})
	}

	child.on("close", (code, signal) => {
		finalize(signal ? "killed" : code === 0 ? "completed" : "failed", code)
	})

	child.on("error", (error) => {
		outStream.write(`Error: ${error.message}\n`)
		finalize("failed", null)
	})

	notify()
	return bgCommand
}

export function getBackgroundCommand(id: string): BackgroundCommand | null {
	const cmd = commands.get(id)
	if (!cmd) return null

	// Refresh output from the temp file: partial while running, final once done.
	// Status itself is owned by the child's close/error events.
	cmd.output = readOutput(cmd)
	return cmd
}

/** Tracked commands, optionally only those started by `owner`. */
export function listBackgroundCommands(owner?: string): BackgroundCommand[] {
	pruneExpired()
	const all = Array.from(commands.values())
	return owner === undefined ? all : all.filter((cmd) => cmd.owner === owner)
}

/** Stop every running command started by `owner` (e.g. when its task is left). */
export function killBackgroundCommandsFor(owner: string): void {
	for (const cmd of commands.values()) {
		if (cmd.owner === owner && cmd.status === "running") killBackgroundCommand(cmd.id)
	}
}

/** Last `maxBytes` of a command's output, without reading the whole log. */
export function readBackgroundOutputTail(id: string, maxBytes = 4096): string {
	const cmd = commands.get(id)
	if (!cmd) return ""
	let fd: number | undefined
	try {
		fd = fs.openSync(cmd.outputFile, "r")
		const size = fs.fstatSync(fd).size
		const length = Math.min(size, maxBytes)
		const buffer = Buffer.alloc(length)
		fs.readSync(fd, buffer, 0, length, size - length)
		return buffer.toString("utf-8")
	} catch {
		return cmd.output.slice(-maxBytes)
	} finally {
		if (fd !== undefined) fs.closeSync(fd)
	}
}

export function killBackgroundCommand(id: string): boolean {
	const cmd = commands.get(id)
	if (!cmd || cmd.status !== "running" || !cmd.pid) return false
	if (!signalCommand(cmd, "SIGTERM")) return false
	// Escalate if the process ignores SIGTERM.
	const escalate = setTimeout(() => {
		if (cmd.status === "running") signalCommand(cmd, "SIGKILL")
	}, KILL_GRACE_MS)
	escalate.unref?.()
	return true
}

/**
 * Commands that finished since the agent was last told, marked as reported.
 * Lets the agent learn about completions without polling.
 */
export function takeFinishedBackgroundCommands(owner?: string): BackgroundCommand[] {
	const finished: BackgroundCommand[] = []
	for (const cmd of commands.values()) {
		if (owner !== undefined && cmd.owner !== owner) continue
		if (cmd.status !== "running" && !cmd.reported) {
			cmd.reported = true
			finished.push(cmd)
		}
	}
	return finished
}

/** Test-only: drop all tracked commands and their temp files. */
export function resetBackgroundCommands() {
	for (const cmd of commands.values()) deleteOutputFile(cmd)
	commands.clear()
	notify()
}
