import path from "node:path"

import { VERSION } from "../branding.js"
import { getShell } from "../utils/shell.js"

// Header names ported from the Orbital extension (shared/kilocode/headers.ts).
export const X_AXONCODE_VERSION = "X-AxonCode-Version"
export const X_AXONCODE_TASKID = "X-AxonCode-TaskId"
export const X_ORGANIZATIONID = "X-KiloCode-OrganizationId"
export const X_AXON_REPO = "X-AXON-REPO"
export const X_MODEL_CONTEXT_WINDOW = "X-Model-Context-Window"
export const X_DEVICE_OS = "X-Device-OS"
export const X_CLIENT_USER_AGENT = "X-Client-User-Agent"

export const DEFAULT_HEADERS = {
	"HTTP-Referer": "https://matterai.so",
	// Kept as "Orbital": this is the protocol value the MatterAI backend
	// already receives from the extension family, not user-facing branding.
	"X-Title": "Orbital",
	[X_AXONCODE_VERSION]: VERSION,
	"User-Agent": `orbcode-cli/${VERSION}`,
}

export function getShellName(shellPath: string): string {
	// Parse both separator styles regardless of the host running OrbCode. This
	// prevents custom shell paths from disclosing usernames or home directories.
	return path.win32
		.basename(path.posix.basename(shellPath))
		.replace(/[^\x20-\x7E]/g, "")
}

export function getClientMetadataHeaders(contextWindow: number): Record<string, string> {
	const shell = getShellName(getShell())
	return {
		[X_MODEL_CONTEXT_WINDOW]: String(contextWindow),
		[X_DEVICE_OS]: process.platform,
		[X_CLIENT_USER_AGENT]: `orbcode-cli/${VERSION}${shell ? ` (${shell})` : ""}`,
	}
}
