import React from "react"
import { render } from "ink"

import { COLORS, PRODUCT_NAME, VERSION } from "./branding.js"
import { App } from "./ui/App.js"
import { runHeadless } from "./headless.js"
import { runMcpCommand } from "./commands/mcp.js"
import { loadSessionById, type SessionData } from "./core/sessions.js"
import {
	clearUpdateCache,
	compareVersions,
	fetchLatestNpmVersion,
	getGlobalInstallRoot,
	getUpdateInfo,
	isGlobalInstall,
	runNpmUpdate,
} from "./utils/updateCheck.js"

const PACKAGE_NAME = "@matterailab/orbcode"
const INK_CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H"
const BEGIN_SYNCHRONIZED_UPDATE = "\x1b[?2026h"
const END_SYNCHRONIZED_UPDATE = "\x1b[?2026l"
// Match OpenTUI's mouse capture: button events, drag events, all movement,
// and SGR coordinates. Capturing all four modes prevents the terminal itself
// from interpreting a wheel/trackpad gesture as scrollback navigation.
const ENABLE_MOUSE_TRACKING = "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h"
const DISABLE_MOUSE_TRACKING = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l"

function terminalRows(stdout: NodeJS.WriteStream): number {
	return stdout.rows ?? process.stderr.rows ?? 24
}

function terminalColumns(stdout: NodeJS.WriteStream): number {
	return stdout.columns ?? process.stderr.columns ?? 80
}

/**
 * Ink normally serializes a frame as newline-delimited text. Even when the
 * frame is terminal-height, some terminals can treat those linefeeds as
 * scrollable output. OpenTUI avoids that class of bug by drawing at explicit
 * screen coordinates. This adapter keeps Ink's real dimensions/event stream,
 * but converts every full redraw into cursor-addressed rows with no linefeeds.
 */
function createFullscreenStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
	let previousLines: string[] = []
	let previousRows = 0

	const writeFrame = (frame: string): boolean => {
		const rows = Math.max(1, terminalRows(stdout))
		const lines = frame.split("\n").slice(0, rows)
		while (lines.length < rows) lines.push("")
		if (rows !== previousRows) previousLines = []

		let output = BEGIN_SYNCHRONIZED_UPDATE
		// Do not clear the display here. Several terminals preserve each ED 2
		// operation as scrollback even in the alternate buffer. OpenTUI keeps a
		// retained screen and replaces cells in place; replacing every row with
		// EL 2 gives Ink the same behavior and cannot advance terminal history.
		let changed = false
		for (let row = 0; row < rows; row++) {
			if (lines[row] === previousLines[row]) continue
			changed = true
			output += `\x1b[${row + 1};1H\x1b[2K${lines[row]}`
		}
		previousLines = lines
		previousRows = rows
		if (!changed) return true
		output += END_SYNCHRONIZED_UPDATE
		return stdout.write(output)
	}

	return new Proxy(stdout, {
		get(target, property) {
			// Ink uses these properties to choose its renderer and compute layout.
			// Integrated terminal wrappers do not always expose them on stdout even
			// though stdin/stderr are attached to the same interactive terminal.
			if (property === "rows") return terminalRows(stdout)
			if (property === "columns") return terminalColumns(stdout)
			if (property === "isTTY") return true
			if (property === "write") {
				return (
					chunk: string | Uint8Array,
					encoding?: BufferEncoding | ((error?: Error | null) => void),
					callback?: (error?: Error | null) => void,
				) => {
					if (typeof chunk === "string" && chunk.startsWith(INK_CLEAR_TERMINAL)) {
						const written = writeFrame(chunk.slice(INK_CLEAR_TERMINAL.length))
						const done = typeof encoding === "function" ? encoding : callback
						if (done) process.nextTick(done)
						return written
					}
					return stdout.write(chunk, encoding as BufferEncoding, callback)
				}
			}
			const value = Reflect.get(target, property, target) as unknown
			return typeof value === "function" ? value.bind(target) : value
		},
	})
}

function printHelp(): void {
	console.log(`${PRODUCT_NAME} v${VERSION}

Usage:
  orbcode                 start an interactive session
  orbcode "<prompt>"      start an interactive session with an initial prompt
  orbcode login           sign in to MatterAI
  orbcode update          install the latest version from npm
  orbcode update --force  force a global install even if this CLI doesn't look global
  orbcode mcp add ...     add an MCP server (see: orbcode mcp help)
  orbcode mcp remove ...  remove an MCP server
  orbcode mcp list        list configured MCP servers
  orbcode mcp migrate     import MCP servers from Claude Code / Claude Desktop
  orbcode -p "<prompt>"   run a single prompt non-interactively (prints only the final response)
  orbcode -p "…" --yolo   non-interactive with auto-approved edits/commands
  orbcode --model <id>    use a specific model for this run
  orbcode --resume <id>   resume a previous session by id
  orbcode -s "<prompt>"   override the default system prompt (replaces it entirely;
                          accepts -s <text>, --system-prompt <text>, and
                          --system-prompt=<text> for values that start with '-')
  orbcode --version       print version
  orbcode --help          show this help
`)
}

async function runUpdate(force: boolean): Promise<number> {
	const latest = await fetchLatestNpmVersion(PACKAGE_NAME)
	if (latest === null) {
		console.error("Could not reach the npm registry. Check your network connection and try again.")
		return 1
	}
	if (compareVersions(VERSION, latest) >= 0) {
		console.log(`${PRODUCT_NAME} v${VERSION} is already up to date (latest: v${latest}).`)
		return 0
	}
	console.log(`Updating ${PRODUCT_NAME} v${VERSION} → v${latest}…`)
	const global = isGlobalInstall()
	if (!global && !force) {
		const root = await getGlobalInstallRoot()
		console.error(
			`This CLI was not installed globally (entrypoint = ${process.argv[1] || import.meta.url || "<unknown>"}).\n` +
				`To update a local/dev install, run \`npm install -g ${PACKAGE_NAME}@latest\` manually, or \`npm install\` inside the source checkout.` +
				(root ? `\nGlobal install root detected at: ${root}` : ""),
		)
		return 1
	}
	if (!global && force) {
		const root = await getGlobalInstallRoot()
		console.warn(
			`Warning: forcing global install even though this CLI doesn't look like a global install.` +
				(root ? ` Detected global root: ${root}.` : ""),
		)
	}
	clearUpdateCache()
	const code = await runNpmUpdate(PACKAGE_NAME)
	if (code === 0) {
		console.log(`Updated to v${latest}. Run \`${PRODUCT_NAME.split(" ")[0].toLowerCase()}\` again to use it.`)
	}
	return code
}

/** Pop `flag <value>` (accepting -flag and --flag) out of args; returns the value. */
function takeFlagValue(args: string[], name: string): string | undefined {
	const index = args.findIndex((a) => a === `--${name}` || a === `-${name}`)
	if (index === -1) return undefined
	const value = args[index + 1]
	if (!value || value.startsWith("-")) {
		console.error(`Missing value after --${name}`)
		process.exit(1)
	}
	args.splice(index, 2)
	return value
}

/**
 * Pop the `-s` / `--system-prompt` flag (and its value) out of `args`.
 * Unlike `takeFlagValue` this accepts a value that starts with `-`, because
 * a system-prompt override is free-form text. Supports three forms:
 *   -s "<text>"             --value in next arg
 *   --system-prompt "<text>"
 *   --system-prompt="<text>"
 *   --system-prompt=-<text>
 */
function takeSystemPrompt(args: string[]): string | undefined {
	const longWithEq = args.findIndex((a) => a.startsWith("--system-prompt="))
	if (longWithEq !== -1) {
		const value = args[longWithEq].slice("--system-prompt=".length)
		args.splice(longWithEq, 1)
		return value.length > 0 ? value : undefined
	}
	const index = args.findIndex((a) => a === "-s" || a === "--system-prompt")
	if (index === -1) return undefined
	const value = args[index + 1]
	if (value === undefined) {
		console.error("Missing value after -s / --system-prompt")
		process.exit(1)
	}
	args.splice(index, 2)
	return value
}

async function main(): Promise<void> {
	// Override Node's default process title so terminals (iTerm2 "current job
	// name", VSCode terminal status, etc.) don't append " (node)" next to our
	// own title. The bundled bin/orbcode.js also does this for the npm case.
	process.title = "orbcode"
	const args = process.argv.slice(2)

	if (args.includes("--version") || args.includes("-v")) {
		console.log(VERSION)
		return
	}
	if (args.includes("--help") || args.includes("-h")) {
		printHelp()
		return
	}
	if (args[0] === "update") {
		const force = args.includes("--force") || args.includes("-f")
		const code = await runUpdate(force)
		process.exit(code)
	}

	// `orbcode mcp ...` — manage MCP servers from the command line (add/remove/list).
	if (args[0] === "mcp") {
		const code = await runMcpCommand(args.slice(1))
		process.exit(code)
	}

	const model = takeFlagValue(args, "model") ?? takeFlagValue(args, "m")
	if (model) {
		// loadSettings() treats MATTERAI_MODEL as the highest-precedence override,
		// so the flag reaches both the TUI and headless mode without plumbing.
		process.env.MATTERAI_MODEL = model
	}

	let initialSession: SessionData | undefined
	const resumeId = takeFlagValue(args, "resume") ?? takeFlagValue(args, "r")
	if (resumeId) {
		initialSession = loadSessionById(resumeId)
		if (!initialSession) {
			console.error(`Session "${resumeId}" not found.`)
			process.exit(1)
		}
	}

	// `-s` / `--system-prompt` lets the user replace the default prompt
	// entirely. Accepts values starting with `-` (unlike other flags), so
	// `orbcode -s '- you are a code reviewer'` works.
	const systemPromptOverride = takeSystemPrompt(args)

	const printIndex = args.findIndex((a) => a === "-p" || a === "--print")
	if (printIndex !== -1) {
		const prompt = args[printIndex + 1]
		if (!prompt) {
			console.error("Missing prompt after -p")
			process.exit(1)
		}
		await runHeadless(prompt, args.includes("--yolo"), systemPromptOverride)
		return
	}

	const initialView = args[0] === "login" ? ("login" as const) : undefined
	// Any other bare argument starts the TUI with that text as the first prompt.
	const initialPrompt = initialView ? undefined : args.find((a) => !a.startsWith("-"))

	// OpenTUI treats its TUI command as a terminal application regardless of
	// stdout.isTTY. Some integrated/wrapped terminals expose TTY only on stdin
	// or stderr; gating on stdout alone leaves the app in the primary buffer.
	const isInteractiveTerminal = Boolean(
		process.stdin.isTTY || process.stdout.isTTY || process.stderr.isTTY,
	)

	// Take over the full terminal as an independent surface:
	//   1. Enter the alternate screen buffer (\x1b[?1049h) so the TUI owns
	//      the full terminal and prior output stays untouched in the primary
	//      buffer — the terminal scrollback is not affected.
	//   2. Set default foreground / background via OSC 10/11 to our greyscale
	//      palette so text without an explicit color prop still follows the
	//      theme instead of falling back to the terminal's default colors.
	// OpenTUI relies on 1049 to create the clean alternate buffer and then
	// updates retained rows; do not issue ED 2 here because some terminals save
	// cleared displays into history even while switching buffers.
	if (isInteractiveTerminal) {
		process.stdout.write("\x1b[?25l\x1b[s\x1b[?1049h")
		process.stdout.write(`\x1b]10;${COLORS.primary}\x07`)
		process.stdout.write(`\x1b]11;${COLORS.bg}\x07`)
		process.stdout.write(ENABLE_MOUSE_TRACKING)
		process.stdout.write("\x1b]0;orbcode\x07")
	}

	// Restore the terminal on exit: reset default colors and leave the
	// alternate screen buffer so the user's prior terminal state is restored.
	function restoreTerminal(): void {
		if (isInteractiveTerminal && process.stdout.writable) {
			process.stdout.write(DISABLE_MOUSE_TRACKING)
			process.stdout.write("\x1b]110\x07")
			process.stdout.write("\x1b]111\x07")
			process.stdout.write("\x1b[?1049l")
		}
	}
	process.on("exit", restoreTerminal)
	const fullscreenStdout = isInteractiveTerminal
		? createFullscreenStdout(process.stdout)
		: process.stdout

	// Fire-and-forget: a stale or no-network state just means the header shows
	// the "current version" line instead of an upgrade prompt.
	const updateCheckPromise = getUpdateInfo(PACKAGE_NAME, VERSION)
	render(
		<App
			initialView={initialView}
			initialPrompt={initialPrompt}
			initialSession={initialSession}
			systemPromptOverride={systemPromptOverride}
			updateCheck={updateCheckPromise}
		/>,
		{ stdout: fullscreenStdout },
	)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
