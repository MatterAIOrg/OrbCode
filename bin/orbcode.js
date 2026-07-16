#!/usr/bin/env node
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

process.title = "orbcode"

const args = process.argv.slice(2)
const first = args[0]
const runsWithoutTui =
	args.includes("--help") ||
	args.includes("-h") ||
	args.includes("--version") ||
	args.includes("-v") ||
	args.includes("--print") ||
	args.includes("-p") ||
	first === "update" ||
	first === "mcp" ||
	first === "plugin" ||
	first === "plugins"

if (!runsWithoutTui && !process.versions.bun) {
	const entrypoint = fileURLToPath(new URL("../dist/index.js", import.meta.url))
	let bunExecutable
	try {
		bunExecutable = createRequire(import.meta.url).resolve("bun/bin/bun.exe")
	} catch {
		console.error("OrbCode's bundled UI runtime is missing. Reinstall @matterailab/orbcode and try again.")
		process.exit(1)
	}
	const child = spawn(bunExecutable, [entrypoint, ...args], { stdio: "inherit" })
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
	if (result.error) {
		console.error(`Unable to launch OrbCode's UI runtime: ${result.error.message}`)
		process.exit(1)
	}
	if (result.signal) process.kill(process.pid, result.signal)
	process.exit(result.code ?? 1)
}

await import("../dist/index.js")
