import React from "react"
import { render } from "ink"

import { PRODUCT_NAME, VERSION } from "./branding.js"
import { App } from "./ui/App.js"
import { runHeadless } from "./headless.js"
import { loadSessionById, type SessionData } from "./core/sessions.js"

function printHelp(): void {
	console.log(`${PRODUCT_NAME} v${VERSION}

Usage:
  orbcode                 start an interactive session
  orbcode "<prompt>"      start an interactive session with an initial prompt
  orbcode login           sign in to MatterAI
  orbcode -p "<prompt>"   run a single prompt non-interactively (prints only the final response)
  orbcode -p "…" --yolo   non-interactive with auto-approved edits/commands
  orbcode --model <id>    use a specific model for this run
  orbcode --resume <id>   resume a previous session by id
  orbcode --version       print version
  orbcode --help          show this help
`)
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

async function main(): Promise<void> {
	const args = process.argv.slice(2)

	if (args.includes("--version") || args.includes("-v")) {
		console.log(VERSION)
		return
	}
	if (args.includes("--help") || args.includes("-h")) {
		printHelp()
		return
	}

	const model = takeFlagValue(args, "model") ?? takeFlagValue(args, "m")
	if (model) {
		// loadSettings() treats ORBCODE_MODEL as the highest-precedence override,
		// so the flag reaches both the TUI and headless mode without plumbing.
		process.env.ORBCODE_MODEL = model
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

	const printIndex = args.findIndex((a) => a === "-p" || a === "--print")
	if (printIndex !== -1) {
		const prompt = args[printIndex + 1]
		if (!prompt) {
			console.error("Missing prompt after -p")
			process.exit(1)
		}
		await runHeadless(prompt, args.includes("--yolo"))
		return
	}

	const initialView = args[0] === "login" ? ("login" as const) : undefined
	// Any other bare argument starts the TUI with that text as the first prompt.
	const initialPrompt = initialView ? undefined : args.find((a) => !a.startsWith("-"))

	// Take over the full terminal: clear the visible screen and home the cursor
	// so the TUI always starts at the top (prior output stays in scrollback).
	if (process.stdout.isTTY) {
		process.stdout.write("\x1b[2J\x1b[H")
		process.stdout.write("\x1b]0;orbcode\x07")
	}
	render(<App initialView={initialView} initialPrompt={initialPrompt} initialSession={initialSession} />)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
