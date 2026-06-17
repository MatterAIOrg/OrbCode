// In-process TUI test: drives the real App with a fake TTY stdin/stdout,
// the same technique ink-testing-library uses.
import { EventEmitter } from "node:events"
import React from "react"
import { render } from "ink"

import fs from "node:fs"

process.env.MATTERAI_CONFIG_DIR = "/tmp/orbcode-test-config"
// Self-contained fixture: a syntactically valid but fake JWT, so the app starts
// in chat view and API calls fail with a clean 401.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
fs.mkdirSync(process.env.MATTERAI_CONFIG_DIR, { recursive: true })
fs.writeFileSync(
	process.env.MATTERAI_CONFIG_DIR + "/config.json",
	JSON.stringify({
		token: `${b64({ alg: "HS256" })}.${b64({ sub: "test", env: "production" })}.sig`,
		model: "axon-code-2-5-pro",
		autoApproveEdits: false,
		autoApproveSafeCommands: false,
	}),
)

const { App } = await import("./dist/ui/App.js")

class FakeStdin extends EventEmitter {
	isTTY = true
	data = []
	setEncoding() {}
	setRawMode() {}
	ref() {}
	unref() {}
	read() {
		return this.data.shift() ?? null
	}
	write(chunk) {
		this.data.push(chunk)
		this.emit("readable")
	}
}

class FakeStdout extends EventEmitter {
	isTTY = true
	columns = 100
	rows = 40
	frames = []
	write(chunk) {
		this.frames.push(chunk)
		return true
	}
	get output() {
		return this.frames.join("")
	}
}

const stdin = new FakeStdin()
const stdout = new FakeStdout()

const instance = render(React.createElement(App, {}), {
	stdout,
	stdin,
	exitOnCtrlC: false,
	patchConsole: false,
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const clean = (s) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")

function assertContains(label, needle) {
	const ok = clean(stdout.output).includes(needle)
	console.log(`${ok ? "PASS" : "FAIL"}: ${label}`)
	if (!ok) process.exitCode = 1
}

await sleep(300)
const pkgVersion = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version
assertContains("header renders", `OrbCode CLI v${pkgVersion}`)
assertContains("input box renders", ">")

// Slash command menu
stdin.write("/")
await sleep(150)
assertContains("slash menu shows /help", "/help")

// Complete /help command
stdin.write("help")
await sleep(100)
stdin.write("\r")
await sleep(200)
assertContains("/help output lists /model", "/model")
assertContains("/help output lists /logout", "/logout")

// Switch model (single-chunk paste with trailing newline should submit)
stdin.write("/model\r")
await sleep(300)
assertContains("model switch info", "Model switched to")

// Send a chat message (fake token in config -> expect 401 error row)
stdin.write("hello there")
await sleep(100)
stdin.write("\r")
await sleep(300)
assertContains("user row echoes message", "hello there")
console.log("waiting for API round-trip (fake token -> 401)...")
await sleep(8000)
assertContains("error row shows 401", "401")
if (process.exitCode) {
	console.log("---- last output for diagnosis ----")
	console.log(clean(stdout.output).split("\n").filter(Boolean).slice(-25).join("\n"))
}

instance.unmount()
process.exit(process.exitCode ?? 0)
