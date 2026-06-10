// Auth ported from the Orbital extension: a MatterAI JWT acts as the API key.
// Backend URL resolution mirrors getKiloBaseUriFromToken / getKiloUrlFromToken.

export const DEFAULT_BACKEND_URL = "https://api.matterai.so"
export const API_GATEWAY_PATH = "https://api2.matterai.so/v1/web/"

export function getBaseUrlFromToken(token?: string): string {
	if (token) {
		try {
			const payloadString = token.split(".")[1]
			if (payloadString) {
				const payload = JSON.parse(Buffer.from(payloadString, "base64").toString())
				// UNTRUSTED payload: only used to detect the development environment,
				// never to read URLs directly.
				if (payload.env === "development") return "http://localhost:3000"
			}
		} catch {
			// fall through to production URL
		}
	}
	return DEFAULT_BACKEND_URL
}

/** Re-host targetUrl onto the backend resolved from the token. */
export function getUrlFromToken(targetUrl: string, token?: string): string {
	const target = new URL(targetUrl)
	const { protocol, host } = new URL(getBaseUrlFromToken(token))
	Object.assign(target, { protocol, host })
	return target.toString()
}

export const APP_URL = "https://app.matterai.so"

export function getSignInUrl(): string {
	return `${APP_URL}/authentication/sign-in?loginType=extension&source=cli`
}

// ---- Device-code (polling) login flow ----
//
// 1. startDeviceAuth() registers a one-time device code with the backend.
// 2. The browser is opened at getAuthorizeUrl(code): if the user is signed in
//    the webapp shows the "Authorize OrbCode CLI" dialog; otherwise it
//    redirects to sign-in, preserving the devicecode, and shows it after.
// 3. pollDeviceAuth(code) is called until it returns the token.

export interface DeviceAuthStart {
	devicecode: string
	expiresIn: number
	interval: number
}

function deviceAuthBaseUrl(): string {
	return process.env.ORBCODE_BACKEND_URL || DEFAULT_BACKEND_URL
}

function deviceAuthAppUrl(): string {
	return process.env.ORBCODE_APP_URL || APP_URL
}

export async function startDeviceAuth(): Promise<DeviceAuthStart> {
	const response = await fetch(`${deviceAuthBaseUrl()}/orbcode/auth/start`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	})
	if (!response.ok) {
		throw new Error(`Could not start sign-in (${response.status}). Try again or paste a token manually.`)
	}
	const data = (await response.json()) as Partial<DeviceAuthStart>
	if (!data.devicecode) {
		throw new Error("Sign-in service returned no device code.")
	}
	return {
		devicecode: data.devicecode,
		expiresIn: data.expiresIn ?? 600,
		interval: data.interval ?? 3,
	}
}

export function getAuthorizeUrl(devicecode: string): string {
	return `${deviceAuthAppUrl()}/orbital?loginType=orbcode&devicecode=${encodeURIComponent(devicecode)}`
}

export type DeviceAuthPollResult =
	| { status: "pending" }
	| { status: "expired" }
	| { status: "authorized"; token: string }

export async function pollDeviceAuth(devicecode: string): Promise<DeviceAuthPollResult> {
	const response = await fetch(
		`${deviceAuthBaseUrl()}/orbcode/auth/poll?devicecode=${encodeURIComponent(devicecode)}`,
	)
	if (!response.ok) {
		// Transient server/network errors are treated as pending; the caller's
		// overall deadline still bounds the wait.
		return { status: "pending" }
	}
	const data = (await response.json()) as { status?: string; token?: string }
	if (data.status === "authorized" && data.token) {
		return { status: "authorized", token: data.token }
	}
	if (data.status === "expired") {
		return { status: "expired" }
	}
	return { status: "pending" }
}

export interface ProfileData {
	user?: { name?: string; email?: string; image?: string }
	organizations?: Array<{ id: string; name: string; role?: string }>
	// Usage fields from /axoncode/profile (same as the extension's profile view).
	plan?: string
	remainingReviews?: number
	usagePercentage?: number
	creditsResetDate?: string
	[key: string]: unknown
}

export async function fetchProfile(token: string): Promise<ProfileData> {
	const url = getUrlFromToken("https://api.matterai.so/axoncode/profile", token)
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
	})
	if (!response.ok) {
		throw new Error(`Profile request failed (${response.status}). Your token may be invalid or expired.`)
	}
	return (await response.json()) as ProfileData
}

/**
 * Extract a clean title from potentially malformed input: a plain string,
 * a JSON object string ('{"title":"…"}'), or an object with a title field.
 * Ported from the extension's taskMetadata sanitizeTitle.
 */
function sanitizeTitle(raw: unknown): string | undefined {
	if (raw == null) return undefined
	if (typeof raw === "string") {
		const trimmed = raw.trim()
		if (!trimmed) return undefined
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				const extracted = sanitizeTitle(JSON.parse(trimmed))
				if (extracted) return extracted
			} catch {
				// not JSON, use as plain string
			}
		}
		return trimmed
	}
	if (typeof raw === "object") {
		const maybe = (raw as Record<string, unknown>)["title"]
		if (maybe != null) return sanitizeTitle(maybe)
	}
	return undefined
}

/**
 * Fetch the backend-generated task title (GET /axoncode/meta/<taskId>).
 * The title only exists after the first response starts streaming, so this
 * retries a few times. Ported from the extension's fetchTaskTitle.
 */
export async function fetchTaskTitle(
	taskId: string,
	token: string,
	maxRetries = 3,
	retryDelayMs = 2000,
): Promise<string | null> {
	if (!token) return null
	const url = getUrlFromToken(`https://api.matterai.so/axoncode/meta/${taskId}`, token)

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const response = await fetch(url, {
				headers: { Authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(5000),
			})
			if (response.ok) {
				const data: unknown = await response.json().catch(() => undefined)
				const title = sanitizeTitle(data)
				if (title) return title
			}
		} catch {
			// network/timeout: fall through to retry
		}
		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
		}
	}
	return null
}

export async function fetchBalance(token: string, organizationId?: string): Promise<number | undefined> {
	try {
		const url = getUrlFromToken("https://api.matterai.so/api/profile/balance", token)
		const headers: Record<string, string> = { Authorization: `Bearer ${token}` }
		if (organizationId) headers["X-KiloCode-OrganizationId"] = organizationId
		const response = await fetch(url, { headers })
		if (!response.ok) return undefined
		const data = (await response.json()) as { balance?: number }
		return data.balance
	} catch {
		return undefined
	}
}

/** Validate a pasted token: well-formed JWT + accepted by the profile endpoint. */
export async function verifyToken(token: string): Promise<ProfileData> {
	if (token.split(".").length !== 3) {
		throw new Error("That doesn't look like a valid token (expected a JWT).")
	}
	return fetchProfile(token)
}
