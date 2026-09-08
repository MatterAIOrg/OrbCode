import { execSync } from "node:child_process"
import { platform } from "node:os"

/**
 * Copy text to the system clipboard. Uses the platform's native clipboard
 * utility (pbcopy on macOS, wl-copy/xclip/xsel on Linux, clip on Windows).
 * Also writes to the terminal clipboard via OSC 52 if a renderer is provided.
 * Returns true on success, false if no clipboard mechanism succeeded.
 */
export function copyToClipboard(
	text: string,
	renderer?: { copyToClipboardOSC52?(text: string): boolean },
): boolean {
	let success = false
	const cmd = clipboardCommand()
	if (cmd) {
		try {
			execSync(cmd, { input: text, stdio: ["pipe", "ignore", "ignore"] })
			success = true
		} catch {}
	}
	if (renderer?.copyToClipboardOSC52) {
		try {
			const oscSuccess = renderer.copyToClipboardOSC52(text)
			if (oscSuccess) success = true
		} catch {}
	}
	return success
}

/** Detect the platform's clipboard command, or null if none is available. */
function clipboardCommand(): string | null {
	const p = platform()
	if (p === "darwin") return "pbcopy"
	if (p === "win32") return "clip"
	// Linux: try wl-copy (Wayland), then xclip, then xsel. We can't check
	// availability without spawning, so prefer wl-copy/xclip and fall back to xsel.
	if (p === "linux") {
		try {
			execSync("which wl-copy", { stdio: "ignore" })
			return "wl-copy"
		} catch {
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
	}
	return null
}
