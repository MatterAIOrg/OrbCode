// Picks which OrbCode install should handle this launch: the copy this file
// ships in, or a newer version the background updater staged under
// ~/.orbcode/versions/<version>/. Every failure path returns null, which means
// "run the current copy" — exactly the behaviour before background updates.
//
// Plain JS with no dependencies: it runs before anything else, under Node.
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const PACKAGE_PATH = ["node_modules", "@matterailab", "orbcode"]
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export const HEALTHY_MARKER = ".healthy"
export const ATTEMPTS_MARKER = ".attempts"
/** Launches that may fail to reach a healthy state before a version is skipped. */
export const MAX_UNHEALTHY_LAUNCHES = 1

export function getVersionsDir(env = process.env) {
	const configDir = env.MATTERAI_CONFIG_DIR || path.join(os.homedir(), ".orbcode")
	return path.join(configDir, "versions")
}

export function getVersionBin(versionDir) {
	return path.join(versionDir, ...PACKAGE_PATH, "bin", "orbcode.js")
}

export function isVersionString(value) {
	return typeof value === "string" && VERSION_RE.test(value)
}

/** -1 / 0 / 1, matching src/utils/updateCheck.ts#compareVersions. */
export function compareVersions(a, b) {
	const split = (v) => {
		const [main, pre = ""] = v.split("-", 2)
		const parts = main.split(".").map((p) => {
			const n = Number.parseInt(p, 10)
			return Number.isFinite(n) ? n : 0
		})
		while (parts.length < 3) parts.push(0)
		return [parts, pre]
	}
	const [aMain, aPre] = split(a)
	const [bMain, bPre] = split(b)
	for (let i = 0; i < 3; i++) {
		if (aMain[i] !== bMain[i]) return aMain[i] < bMain[i] ? -1 : 1
	}
	if (aPre === bPre) return 0
	if (aPre === "") return 1
	if (bPre === "") return -1
	return aPre < bPre ? -1 : 1
}

export function readAttempts(versionDir) {
	try {
		const n = Number.parseInt(fs.readFileSync(path.join(versionDir, ATTEMPTS_MARKER), "utf8"), 10)
		return Number.isFinite(n) && n > 0 ? n : 0
	} catch {
		return 0
	}
}

export function isHealthy(versionDir) {
	return fs.existsSync(path.join(versionDir, HEALTHY_MARKER))
}

/** A staged version that failed to start and never proved itself healthy. */
export function isBad(versionDir) {
	return !isHealthy(versionDir) && readAttempts(versionDir) >= MAX_UNHEALTHY_LAUNCHES
}

/**
 * Returns `{ version, bin }` for a staged version to delegate to, or null to
 * run the current copy. `countAttempt` is false for launches that never reach
 * a health check (--version / --help) so they can't mark a version bad.
 */
export function selectStagedVersion({ selfVersion, env = process.env, countAttempt = true }) {
	try {
		if (env.ORBCODE_DELEGATED) return null
		if (!isVersionString(selfVersion)) return null
		const versionsDir = getVersionsDir(env)
		const current = fs.readFileSync(path.join(versionsDir, "current"), "utf8").trim()
		if (!isVersionString(current)) return null
		if (compareVersions(current, selfVersion) <= 0) return null
		const versionDir = path.join(versionsDir, current)
		const bin = getVersionBin(versionDir)
		if (!fs.existsSync(bin)) return null
		if (!isHealthy(versionDir)) {
			const attempts = readAttempts(versionDir)
			if (attempts >= MAX_UNHEALTHY_LAUNCHES) return null
			if (countAttempt) fs.writeFileSync(path.join(versionDir, ATTEMPTS_MARKER), String(attempts + 1))
		}
		return { version: current, bin }
	} catch {
		return null
	}
}
