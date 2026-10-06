#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

process.title = "orbcode"

const args = process.argv.slice(2)
const first = args[0]
const versionOrHelpOnly =
	args.includes("--help") || args.includes("-h") || args.includes("--version") || args.includes("-v")
const runsWithoutTui =
	versionOrHelpOnly ||
	args.includes("--print") ||
	args.includes("-p") ||
	first === "update" ||
	first === "mcp" ||
	first === "plugin" ||
	first === "plugins"

/** Run a child with inherited stdio, forwarding termination signals to it. */
async function runChild(command, childArgs, env) {
	const child = spawn(command, childArgs, { stdio: "inherit", env })
	const forwardedSignals = ["SIGINT", "SIGTERM", "SIGHUP"]
	const forwarders = new Map()
	for (const signal of forwardedSignals) {
		const forward = () => child.kill(signal)
		forwarders.set(signal, forward)
		process.on(signal, forward)
	}
	const result = await new Promise((resolve) => {
		child.once("error", (error) => resolve({ error }))
		child.once("exit", (code, signal) => resolve({ code, signal }))
	})
	for (const [signal, forward] of forwarders) process.off(signal, forward)
	return result
}

function exitLike(result) {
	if (result.signal) process.kill(process.pid, result.signal)
	process.exit(result.code ?? 1)
}

// Hand off to a newer version staged by the background updater, if any. Any
// problem selecting or starting it falls through to running this copy.
if (!process.versions.bun) {
	let staged = null
	try {
		const { selectStagedVersion } = await import("./select-version.js")
		const selfVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version
		staged = selectStagedVersion({ selfVersion, countAttempt: !versionOrHelpOnly })
	} catch {
		staged = null
	}
	if (staged) {
		const result = await runChild(process.execPath, [staged.bin, ...args], {
			...process.env,
			ORBCODE_DELEGATED: "1",
		})
		if (!result.error) exitLike(result)
	}
}

if (!runsWithoutTui && !process.versions.bun) {
	const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url))
	let bunExecutable
	try {
		bunExecutable = createRequire(import.meta.url).resolve("bun/bin/bun.exe")
	} catch {
		console.error("OrbCode's bundled UI runtime is missing. Reinstall @matterailab/orbcode and try again.")
		process.exit(1)
	}
	// The background updater verifies new versions through this same Node
	// launcher, so it needs to know which Node binary started us.
	const result = await runChild(bunExecutable, [entrypoint, ...args], {
		...process.env,
		ORBCODE_NODE_PATH: process.env.ORBCODE_NODE_PATH || process.execPath,
	})
	if (result.error) {
		console.error(`Unable to launch OrbCode's UI runtime: ${result.error.message}`)
		process.exit(1)
	}
	exitLike(result)
}

await import("../dist/index.js")
