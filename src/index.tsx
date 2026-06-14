import React from "react"
import { render } from "ink"

import { PRODUCT_NAME, VERSION } from "./branding.js"
import { App } from "./ui/App.js"
import { runHeadless } from "./headless.js"
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

function printHelp(): void {
	console.log(`${PRODUCT_NAME} v${VERSION}

Usage:
  orbcode                 start an interactive session
  orbcode "<prompt>"      start an interactive session with an initial prompt
  orbcode login           sign in to MatterAI
  orbcode update          install the latest version from npm
  orbcode update --force  force a global install even if this CLI doesn't look global
  orbcode -p "<prompt>"   run a single prompt non-interactively (prints only the final response)
  orbcode -p "…" --yolo   non-interactive with auto-approved edits/commands
  orbcode --model <id>    use a specific model for this run
  orbcode --resume <id>   resume a previous session by id
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
	// Fire-and-forget: a stale or no-network state just means the header shows
	// the "current version" line instead of an upgrade prompt.
	const updateCheckPromise = getUpdateInfo(PACKAGE_NAME, VERSION)
	render(
		<App
			initialView={initialView}
			initialPrompt={initialPrompt}
			initialSession={initialSession}
			updateCheck={updateCheckPromise}
		/>,
	)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
