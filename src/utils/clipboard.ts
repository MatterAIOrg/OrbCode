import { execSync } from "node:child_process"
import { platform } from "node:os"

/**
 * Copy text to the system clipboard. Uses the platform's native clipboard
 * utility (pbcopy on macOS, xclip/xsel on Linux, clip on Windows). Returns
 * true on success, false if no clipboard utility is available.
 */
export function copyToClipboard(text: string): boolean {
	const cmd = clipboardCommand()
	if (!cmd) return false
	try {
		execSync(cmd, { input: text, stdio: ["pipe", "ignore", "ignore"] })
		return true
	} catch {
		return false
	}
}

/** Detect the platform's clipboard command, or null if none is available. */
function clipboardCommand(): string | null {
	const p = platform()
	if (p === "darwin") return "pbcopy"
	if (p === "win32") return "clip"
	// Linux: try xclip, then xsel. We can't check availability without spawning,
	// so prefer xclip (more common on modern distros) and fall back to xsel.
	if (p === "linux") {
		try {
			execSync("which xclip", { stdio: "ignore" })
			return "xclip -selection clipboard"
		} catch {
			try {
				execSync("which xsel", { stdio: "ignore" })
				return "xsel --clipboard --input"
			} catch {
				return null
			}
		}
	}
	return null
}
