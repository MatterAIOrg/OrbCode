/**
 * Cross-platform shell selection. On Windows, $SHELL is normally unset and
 * unix paths like /bin/sh do not exist, so we use ComSpec (cmd.exe); on
 * POSIX systems we honor the user's shell with a /bin/sh fallback.
 */
export function getShell(): string {
	if (process.platform === "win32") {
		return process.env.ComSpec || "cmd.exe"
	}
	return process.env.SHELL || "/bin/sh"
}

/** Arguments that make the shell run a single command string. */
export function getShellRunArgs(command: string): string[] {
	if (process.platform === "win32") {
		// /d skips AutoRun, /s preserves quotes in the command string.
		return ["/d", "/s", "/c", command]
	}
	return ["-c", command]
}
