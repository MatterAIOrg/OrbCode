import * as fs from "node:fs"
import * as path from "node:path"

/**
 * Cross-platform shell selection. Commands are written in bash syntax (the
 * model is told so, and the read-only classifier assumes it), so we run bash
 * whenever it exists instead of trusting $SHELL, which may be fish or csh:
 *   - POSIX: bash, else zsh when that is the user's shell, else /bin/sh.
 *   - Windows: Git Bash when installed, else ComSpec (cmd.exe).
 */
let cached: string | undefined

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
