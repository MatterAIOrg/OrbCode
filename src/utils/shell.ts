import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"

/**
 * Cross-platform shell selection. Commands are written in bash syntax (the
 * model is told so, and the read-only classifier assumes it), so we run bash
 * whenever it exists instead of trusting $SHELL, which may be fish or csh:
 *   - POSIX: bash, else zsh when that is the user's shell, else /bin/sh.
 *   - Windows: Git Bash when installed, else ComSpec (cmd.exe).
 */
let cached: string | undefined
let cachedRgBinDir: string | null | undefined

const require = createRequire(import.meta.url)

/**
 * Resolve the bundled `@vscode/ripgrep` binary path, if installed for this
 * platform/arch (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`,
 * `win32-x64`, `win32-arm64`, etc.).
 */
export function getBundledRipgrepPath(): string | undefined {
	try {
		const mod = require("@vscode/ripgrep") as { rgPath?: unknown }
		if (typeof mod.rgPath === "string" && fs.statSync(mod.rgPath, { throwIfNoEntry: false })?.isFile()) {
			return mod.rgPath
		}
	} catch {
		// Platform binary package may not be installed on an unsupported architecture.
	}
	return undefined
}

/**
 * Directory containing the bundled `rg` (`rg.exe` on Windows) binary, so we
 * can append it to `PATH` when spawning shell commands and hooks. Appending
 * (rather than prepending) respects any `rg` the user already has on `PATH`
 * while guaranteeing `rg` works out of the box when not installed globally.
 */
export function getBundledRipgrepDir(): string | undefined {
	if (cachedRgBinDir === undefined) {
		const rgPath = getBundledRipgrepPath()
		cachedRgBinDir = rgPath ? path.dirname(rgPath) : null
	}
	return cachedRgBinDir ?? undefined
}

/**
 * Return `baseEnv` with the bundled ripgrep directory appended to `PATH` (or
 * `Path` on Windows when that casing is used) if not already present.
 */
export function withBundledToolsOnPath(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const rgDir = getBundledRipgrepDir()
	if (!rgDir) return { ...baseEnv }
	const env: NodeJS.ProcessEnv = { ...baseEnv }
	const pathKey =
		process.platform === "win32"
			? (Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH")
			: "PATH"
	const current = env[pathKey] ?? ""
	const entries = current.split(path.delimiter).filter(Boolean)
	if (!entries.includes(rgDir)) {
		env[pathKey] = entries.length > 0 ? `${current}${path.delimiter}${rgDir}` : rgDir
	}
	return env
}

function firstExisting(candidates: string[]): string | undefined {
	return candidates.find((candidate) => {
		try {
			return fs.statSync(candidate).isFile()
		} catch {
			return false
		}
	})
}

function findOnPath(binary: string, skip: (dir: string) => boolean = () => false): string | undefined {
	const dirs = (process.env.PATH ?? "").split(path.delimiter).filter((dir) => dir && !skip(dir))
	return firstExisting(dirs.map((dir) => path.join(dir, binary)))
}

function findWindowsBash(): string | undefined {
	const roots = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs")]
	const known = firstExisting(roots.filter(Boolean).flatMap((root) => [path.join(root!, "Git", "bin", "bash.exe"), path.join(root!, "Git", "usr", "bin", "bash.exe")]))
	// System32\bash.exe is the WSL launcher, which runs a different filesystem.
	return known ?? findOnPath("bash.exe", (dir) => /[\\/]system32$/i.test(dir) || /[\\/]windowsapps$/i.test(dir))
}

function resolveShell(): string {
	if (process.platform === "win32") {
		return findWindowsBash() ?? (process.env.ComSpec || "cmd.exe")
	}
	const userShell = process.env.SHELL
	if (userShell && path.basename(userShell) === "bash") return userShell
	const bash = firstExisting(["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/opt/homebrew/bin/bash"]) ?? findOnPath("bash")
	if (bash) return bash
	if (userShell && path.basename(userShell) === "zsh") return userShell
	return "/bin/sh"
}

export function getShell(): string {
	return (cached ??= resolveShell())
}

/** True when the selected shell is cmd.exe, i.e. bash syntax will not work. */
export function isCmdShell(shell: string = getShell()): boolean {
	return /(^|[\\/])cmd(\.exe)?$/i.test(shell)
}

/** Arguments that make the shell run a single command string. */
export function getShellRunArgs(command: string): string[] {
	if (isCmdShell()) {
		// /d skips AutoRun, /s preserves quotes in the command string.
		return ["/d", "/s", "/c", command]
	}
	return ["-c", command]
}
