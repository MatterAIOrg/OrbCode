import { VERSION } from "../branding.js"

// Header names ported from the Orbital extension (shared/kilocode/headers.ts).
export const X_AXONCODE_VERSION = "X-AxonCode-Version"
export const X_AXONCODE_TASKID = "X-AxonCode-TaskId"
export const X_ORGANIZATIONID = "X-KiloCode-OrganizationId"
export const X_AXON_REPO = "X-AXON-REPO"

export const DEFAULT_HEADERS = {
	"HTTP-Referer": "https://matterai.so",
	// Kept as "Orbital": this is the protocol value the MatterAI backend
	// already receives from the extension family, not user-facing branding.
	"X-Title": "Orbital",
	[X_AXONCODE_VERSION]: VERSION,
	"User-Agent": `orbcode-cli/${VERSION}`,
}
