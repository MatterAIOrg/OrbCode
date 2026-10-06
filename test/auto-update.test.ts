import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import test from "node:test"

// @ts-ignore -- plain-JS launcher helper, no type declarations
import { selectStagedVersion } from "../bin/select-version.js"
import {
	isBadVersion,
	readCurrentPointer,
	resolveUpdateNotice,
	satisfiesNodeEngine,
	stageVersion,
} from "../src/utils/autoUpdate.js"

const PKG = "@matterailab/orbcode"

function freshConfigDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-autoupdate-"))
	process.env.MATTERAI_CONFIG_DIR = dir
	return dir
}

function stageFake(configDir: string, version: string): string {
	const binDir = path.join(configDir, "versions", version, "node_modules", "@matterailab", "orbcode", "bin")
	fs.mkdirSync(binDir, { recursive: true })
	fs.writeFileSync(path.join(binDir, "orbcode.js"), "")
	return path.join(configDir, "versions", version)
}

function setPointer(configDir: string, version: string): void {
	fs.mkdirSync(path.join(configDir, "versions"), { recursive: true })
	fs.writeFileSync(path.join(configDir, "versions", "current"), `${version}\n`)
}

const launcherEnv = (configDir: string) => ({ MATTERAI_CONFIG_DIR: configDir })

test("launcher runs itself when nothing is staged or the pointer is unusable", () => {
	const configDir = freshConfigDir()
	assert.equal(selectStagedVersion({ selfVersion: "1.0.0", env: launcherEnv(configDir) }), null)
	setPointer(configDir, "not-a-version")
	assert.equal(selectStagedVersion({ selfVersion: "1.0.0", env: launcherEnv(configDir) }), null)
	// Pointer to a version whose files are missing.
	setPointer(configDir, "2.0.0")
	assert.equal(selectStagedVersion({ selfVersion: "1.0.0", env: launcherEnv(configDir) }), null)
})

test("launcher prefers its own copy when it is the same or newer", () => {
	const configDir = freshConfigDir()
	stageFake(configDir, "1.5.0")
	setPointer(configDir, "1.5.0")
	assert.equal(selectStagedVersion({ selfVersion: "1.5.0", env: launcherEnv(configDir) }), null)
	assert.equal(selectStagedVersion({ selfVersion: "2.0.0", env: launcherEnv(configDir) }), null)
})

test("launcher delegates to a newer staged version and stops after a failed start", () => {
	const configDir = freshConfigDir()
	const dir = stageFake(configDir, "2.0.0")
	setPointer(configDir, "2.0.0")
	const env = launcherEnv(configDir)

	// --version / --help don't count toward the failure budget.
	assert.equal(selectStagedVersion({ selfVersion: "1.0.0", env, countAttempt: false })?.version, "2.0.0")
	assert.equal(fs.existsSync(path.join(dir, ".attempts")), false)

	const picked = selectStagedVersion({ selfVersion: "1.0.0", env })
	assert.equal(picked?.version, "2.0.0")
	assert.match(picked?.bin ?? "", /2\.0\.0.*orbcode\.js$/)

	// It never wrote .healthy, so the next launch falls back to the old copy.
	assert.equal(selectStagedVersion({ selfVersion: "1.0.0", env }), null)
	assert.equal(isBadVersion("2.0.0"), true)
})

test("a healthy staged version keeps being used", () => {
	const configDir = freshConfigDir()
	const dir = stageFake(configDir, "2.0.0")
	setPointer(configDir, "2.0.0")
	fs.writeFileSync(path.join(dir, ".healthy"), "")
	const env = launcherEnv(configDir)
	for (let i = 0; i < 3; i++) {
		assert.equal(selectStagedVersion({ selfVersion: "1.0.0", env })?.version, "2.0.0")
	}
	assert.equal(selectStagedVersion({ selfVersion: "1.0.0", env: { ...env, ORBCODE_DELEGATED: "1" } }), null)
})

test("satisfiesNodeEngine only accepts ranges it understands", () => {
	assert.equal(satisfiesNodeEngine(undefined, "20.1.0"), true)
	assert.equal(satisfiesNodeEngine(">=20.0.0", "20.1.0"), true)
	assert.equal(satisfiesNodeEngine(">=22", "20.1.0"), false)
	assert.equal(satisfiesNodeEngine("^20 || ^22", "20.1.0"), false)
})

test("resolveUpdateNotice leaves the manual banner alone when disabled", async () => {
	freshConfigDir()
	process.env.ORBCODE_DISABLE_AUTOUPDATE = "1"
	try {
		const info = { current: "1.0.0", latest: "2.0.0", updateAvailable: true, unknown: false }
		assert.deepEqual(await resolveUpdateNotice(PKG, info, {}), info)
	} finally {
		delete process.env.ORBCODE_DISABLE_AUTOUPDATE
	}
})

// ── stageVersion against a fake npm ────────────────────────────────────────

const FAKE_NPM = `#!/bin/sh
[ -n "$FAKE_NPM_FAIL" ] && exit 1
for arg in "$@"; do spec="$arg"; done
version="\${spec##*@}"
root="node_modules/@matterailab/orbcode"
mkdir -p "$root/bin"
printf '{"name":"@matterailab/orbcode","version":"%s"}' "$version" > "$root/package.json"
cat > "$root/bin/orbcode.js" <<JS
if (process.argv.includes("--self-test")) {
  if (process.env.FAKE_SELFTEST_FAIL) process.exit(3)
  console.log("ok $version")
} else console.log("$version")
JS
`

function withFakeNpm(): () => void {
	const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "orbcode-fake-npm-"))
	fs.writeFileSync(path.join(binDir, "npm"), FAKE_NPM, { mode: 0o755 })
	const originalPath = process.env.PATH
	process.env.PATH = `${binDir}${path.delimiter}${originalPath}`
	return () => {
		process.env.PATH = originalPath
	}
}

const posixOnly = { skip: process.platform === "win32" ? "fake npm is a shell script" : false }

test("stageVersion installs, verifies and flips the pointer", posixOnly, async () => {
	const configDir = freshConfigDir()
	const restore = withFakeNpm()
	try {
		// An old version superseded long ago gets pruned.
		const oldDir = stageFake(configDir, "0.1.0")
		const marker = path.join(oldDir, ".superseded")
		fs.writeFileSync(marker, "")
		const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
		fs.utimesSync(marker, longAgo, longAgo)
		fs.mkdirSync(path.join(configDir, "versions", "1.9.0.tmp"))

		assert.equal(await stageVersion(PKG, "2.0.0", process.execPath), null)
		assert.equal(readCurrentPointer(), "2.0.0")
		const entries = fs.readdirSync(path.join(configDir, "versions")).sort()
		assert.deepEqual(entries, ["2.0.0", "current"])
	} finally {
		restore()
	}
})

test("a failed install or self-test leaves the pointer untouched", posixOnly, async () => {
	const configDir = freshConfigDir()
	const restore = withFakeNpm()
	try {
		setPointer(configDir, "1.0.0")

		process.env.FAKE_NPM_FAIL = "1"
		assert.match((await stageVersion(PKG, "2.0.0", process.execPath)) ?? "", /npm install exited/)
		delete process.env.FAKE_NPM_FAIL

		process.env.FAKE_SELFTEST_FAIL = "1"
		assert.match((await stageVersion(PKG, "2.0.0", process.execPath)) ?? "", /--self-test failed/)
		delete process.env.FAKE_SELFTEST_FAIL

		assert.equal(readCurrentPointer(), "1.0.0")
		const entries = fs.readdirSync(path.join(configDir, "versions"))
		assert.deepEqual(entries, ["current"])
	} finally {
		restore()
	}
})

test("a concurrent install is skipped rather than raced", posixOnly, async () => {
	const configDir = freshConfigDir()
	fs.mkdirSync(path.join(configDir, "versions"), { recursive: true })
	fs.writeFileSync(path.join(configDir, "versions", ".lock"), `${process.pid}:${Date.now()}`)
	assert.equal(await stageVersion(PKG, "2.0.0", process.execPath), "locked")
	assert.equal(readCurrentPointer(), null)
})
