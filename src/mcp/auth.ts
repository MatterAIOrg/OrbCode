import * as http from "node:http"
import * as fs from "node:fs"
import * as path from "node:path"

import open from "open"
import {
	ClientCredentialsProvider,
	PrivateKeyJwtProvider,
} from "@modelcontextprotocol/sdk/client/auth-extensions.js"
import {
	auth,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js"
import {
	type OAuthClientMetadata,
	type OAuthClientInformationMixed,
	type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"

import { getConfigDir } from "../config/settings.js"
import { VERSION } from "../branding.js"
import type { McpOAuthConfig, McpServerConfig } from "./types.js"

/**
 * MCP OAuth support.
 *
 * Remote MCP servers (http/sse) often require OAuth. The SDK ships a full
 * OAuth client (RFC 9728 discovery + RFC 8414 metadata + PKCE + dynamic client
 * registration + token refresh), gated behind an `OAuthClientProvider` that
 * persists per-server state. This module provides:
 *
 *   - `FileOAuthProvider`: a filesystem-backed provider that stores tokens,
 *     client info, code verifiers, and discovery state per server under
 *     `~/.orbcode/mcp-auth/<server>.json`.
 *   - `startCallbackServer`: a one-shot loopback HTTP server that receives the
 *     OAuth redirect and resolves with the authorization code.
 *   - `buildAuthProvider`: turns an `McpOAuthConfig` into an `OAuthClientProvider`
 *     (interactive auth-code flow, or M2M client_credentials / private_key_jwt).
 *   - `connectWithAuth`: wraps the transport connect + auth retry loop.
 */

const CLIENT_METADATA: OAuthClientMetadata = {
	client_name: "OrbCode CLI",
	redirect_uris: [], // filled in per-callback-port at runtime
	grant_types: ["authorization_code", "refresh_token"],
	token_endpoint_auth_method: "none",
	scope: "",
}

interface McpAuthStore {
	clientInformation?: OAuthClientInformationMixed
	tokens?: OAuthTokens
	codeVerifier?: string
	discoveryState?: OAuthDiscoveryState
	client?: OAuthClientInformationMixed
}

/** Directory holding per-server OAuth state files. */
function authDir(): string {
	return path.join(getConfigDir(), "mcp-auth")
}

/** Path to a server's persistent OAuth store. */
function authFilePath(serverName: string): string {
	return path.join(authDir(), `${serverName}.json`)
}

/** Read a server's OAuth store (or undefined if none). */
function readAuthStore(serverName: string): McpAuthStore | undefined {
	try {
		return JSON.parse(fs.readFileSync(authFilePath(serverName), "utf8"))
	} catch {
		return undefined
	}
}

/** Write a server's OAuth store (best-effort). */
function writeAuthStore(serverName: string, store: McpAuthStore): void {
	try {
		fs.mkdirSync(authDir(), { recursive: true })
		fs.writeFileSync(authFilePath(serverName), JSON.stringify(store, null, "\t") + "\n", {
			mode: 0o600,
		})
	} catch {
		// best-effort; auth will just re-prompt next time
	}
}

/** A filesystem-backed OAuthClientProvider for one MCP server. */
class FileOAuthProvider implements OAuthClientProvider {
	private readonly serverName: string
	private readonly callbackPort: number
	private readonly scope?: string
	private store: McpAuthStore
	/** The authorization URL captured from the last redirectToAuthorization call. */
	private authUrl?: string
	/** Resolved by redirectToAuthorization; awaited by the connect loop. */
	private codeResolve?: (code: string) => void

	constructor(serverName: string, callbackPort: number, scope?: string) {
		this.serverName = serverName
		this.callbackPort = callbackPort
		this.scope = scope
		this.store = readAuthStore(serverName) ?? {}
	}

	get redirectUrl(): string {
		return `http://localhost:${this.callbackPort}/callback`
	}

	get clientMetadata(): OAuthClientMetadata {
		return { ...CLIENT_METADATA, redirect_uris: [this.redirectUrl], scope: this.scope ?? "" }
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.store.clientInformation
	}

	saveClientInformation(info: OAuthClientInformationMixed): void {
		this.store.clientInformation = info
		writeAuthStore(this.serverName, this.store)
	}

	tokens(): OAuthTokens | undefined {
		return this.store.tokens
	}

	saveTokens(tokens: OAuthTokens): void {
		this.store.tokens = tokens
		writeAuthStore(this.serverName, this.store)
	}

	saveCodeVerifier(verifier: string): void {
		this.store.codeVerifier = verifier
		writeAuthStore(this.serverName, this.store)
	}

	codeVerifier(): string {
		if (!this.store.codeVerifier) throw new Error("No PKCE code verifier stored.")
		return this.store.codeVerifier
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.store.discoveryState = state
		writeAuthStore(this.serverName, this.store)
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.store.discoveryState
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "all") this.store = {}
		else if (scope === "client") delete this.store.clientInformation
		else if (scope === "tokens") delete this.store.tokens
		else if (scope === "verifier") delete this.store.codeVerifier
		else if (scope === "discovery") delete this.store.discoveryState
		writeAuthStore(this.serverName, this.store)
	}

	/** Open the user's browser to the authorization URL and capture it so the
	 *  caller can surface it in the TUI (with copy + paste fallback). */
	redirectToAuthorization(authorizationUrl: URL): void {
		this.authUrl = authorizationUrl.toString()
		void open(this.authUrl).catch(() => {
			// best-effort; the user can copy the URL from the TUI
		})
	}

	/** The authorization URL captured from the last redirect (for TUI display). */
	getAuthUrl(): string | undefined {
		return this.authUrl
	}

	/** Called by the callback server when the OAuth redirect lands. */
	resolveCode(code: string): void {
		this.codeResolve?.(code)
	}

	/** Await the authorization code from the browser redirect or a manual paste. */
	waitForCode(): Promise<string> {
		return new Promise<string>((resolve) => {
			this.codeResolve = resolve
		})
	}
}

/** Start a one-shot loopback HTTP server to receive the OAuth redirect. */
function startCallbackServer(
	port: number,
	onCode: (code: string) => void,
): http.Server {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url ?? "/", `http://localhost:${port}`)
		if (url.pathname !== "/callback") {
			res.writeHead(404, { "Content-Type": "text/html" })
			res.end(callbackPage("not-found"))
			return
		}
		const code = url.searchParams.get("code")
		const error = url.searchParams.get("error")
		if (code) {
			onCode(code)
			res.writeHead(200, { "Content-Type": "text/html" })
			res.end(callbackPage("success"))
		} else if (error) {
			const desc = url.searchParams.get("error_description") ?? error
			res.writeHead(400, { "Content-Type": "text/html" })
			res.end(callbackPage("error", desc))
		} else {
			res.writeHead(400, { "Content-Type": "text/html" })
			res.end(callbackPage("error", "Missing authorization code in the callback."))
		}
		// Close after responding so the port is freed immediately.
		server.close()
	})
	server.listen(port, "127.0.0.1")
	return server
}

/** Render the OAuth callback page. Styled to match matterai.so: dark
 *  background, cyan/teal accents, centered card, clean typography. */
function callbackPage(kind: "success" | "error" | "not-found", detail?: string): string {
	const isSuccess = kind === "success"
	const title = isSuccess ? "Authorized" : kind === "not-found" ? "Not Found" : "Authorization Failed"
	const message = isSuccess
		? "You can close this tab and return to OrbCode."
		: kind === "not-found"
			? "This page was not found."
			: detail ?? "An unexpected error occurred during authentication."
	const icon = isSuccess ? "&#10003;" : "&#10007;"
	const accent = isSuccess ? "#3FA266" : "#E34671"

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrbCode &middot; ${title}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0d1117;
    color: #e6edf3;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    text-align: center;
    padding: 3rem 2.5rem;
    max-width: 440px;
    width: 90%;
  }
  .icon {
    width: 72px;
    height: 72px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto 1.75rem;
    font-size: 36px;
    font-weight: 700;
    background: ${accent}1a;
    border: 2px solid ${accent};
    color: ${accent};
  }
  h1 {
    font-size: 1.6rem;
    font-weight: 600;
    letter-spacing: -0.02em;
    margin-bottom: 0.6rem;
  }
  p {
    font-size: 0.95rem;
    line-height: 1.5;
    color: #8b949e;
    margin-bottom: 2rem;
  }
  .brand {
    margin-top: 2.5rem;
    font-size: 0.8rem;
    color: #484f58;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .brand span { color: #c4fdff; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <div class="brand">OrbCode CLI &middot; <span>powered by Axon</span></div>
  </div>
</body>
</html>`
}

/** Pick an ephemeral loopback port for the callback server. */
function ephemeralPort(): number {
	// Bind to port 0 and read back the assigned port, then close immediately.
	const probe = http.createServer().listen(0, "127.0.0.1")
	const addr = probe.address()
	probe.close()
	return typeof addr === "object" && addr ? addr.port : 8765
}

/** Build an OAuthClientProvider from an McpOAuthConfig. Returns the provider
 *  plus a callback-port hint (for the interactive flow). */
export function buildAuthProvider(
	serverName: string,
	oauth: McpOAuthConfig,
): { provider: OAuthClientProvider; callbackPort?: number } {
	// M2M: client_credentials grant (no browser).
	if (typeof oauth === "object" && "grantType" in oauth && oauth.grantType === "client_credentials") {
		return {
			provider: new ClientCredentialsProvider({
				clientId: oauth.clientId,
				clientSecret: oauth.clientSecret,
				scope: oauth.scope,
				clientName: "OrbCode CLI",
			}),
		}
	}

	// M2M: private_key_jwt assertion (no browser).
	if (typeof oauth === "object" && "grantType" in oauth && oauth.grantType === "private_key_jwt") {
		return {
			provider: new PrivateKeyJwtProvider({
				clientId: oauth.clientId,
				privateKey: oauth.privateKey,
				algorithm: oauth.algorithm,
				scope: oauth.scope,
				clientName: "OrbCode CLI",
			}),
		}
	}

	// Interactive authorization-code flow (browser redirect).
	const scope = typeof oauth === "object" ? oauth.scope : undefined
	const port = ephemeralPort()
	return { provider: new FileOAuthProvider(serverName, port, scope), callbackPort: port }
}

/** True if the config requests OAuth (vs. static headers). */
export function hasOAuth(config: { oauth?: McpOAuthConfig }): boolean {
	return config.oauth !== undefined && config.oauth !== false
}

/** True if a server config is http/sse with OAuth enabled. */
export function isOAuthConfig(config: McpServerConfig): boolean {
	return (config.type === "http" || config.type === "sse") && hasOAuth(config)
}

/** True if this server has persisted OAuth tokens (i.e. already authenticated). */
export function hasStoredAuth(serverName: string): boolean {
	const store = readAuthStore(serverName)
	return Boolean(store && store.tokens && store.tokens.access_token)
}

/** Lets the caller intercept the interactive OAuth flow: surface the auth URL
 *  in the TUI and provide the authorization code (from the callback server or
 *  a manual paste). When no intercept is provided, the flow auto-waits for the
 *  loopback callback (headless mode). */
export interface AuthIntercept {
	/** Called with the authorization URL when the flow needs a browser redirect.
	 *  The caller should display it (with copy + paste fallback). */
	onAuthUrl: (url: string) => void
	/** Resolve with the authorization code (from the callback server or a manual
	 *  paste). Reject to abort the auth flow. */
	getCode: () => Promise<string>
}

export interface AuthTransport {
	transport: StreamableHTTPClientTransport | SSEClientTransport
	/** Run the auth flow to obtain/refresh tokens. Resolves when the provider
	 *  has valid tokens; rejects on failure. Does NOT call transport.start() —
	 *  that's done by client.connect() later. */
	authenticate: () => Promise<void>
	/** The provider, if any (for finishAuth coordination). */
	provider?: FileOAuthProvider
}

/** Create an http/sse transport with an auth provider. The `authenticate()`
 *  function uses the standalone `auth()` orchestrator to obtain tokens BEFORE
 *  the transport is started (by client.connect()). This avoids the
 *  "StreamableHTTPClientTransport already started" error that occurs when
 *  transport.start() is called both by authenticate() and by client.connect().
 *
 *  When `intercept` is provided, the caller controls how the auth URL is shown
 *  and how the code is obtained (TUI with copy + paste fallback). When omitted,
 *  the flow auto-waits for the loopback callback server (headless mode). */
export function createAuthTransport(
	serverName: string,
	url: URL,
	kind: "http" | "sse",
	oauth: McpOAuthConfig,
	requestInit: RequestInit,
	intercept?: AuthIntercept,
): AuthTransport {
	const { provider, callbackPort } = buildAuthProvider(serverName, oauth)
	const fileProvider = provider instanceof FileOAuthProvider ? provider : undefined

	const transport =
		kind === "http"
			? new StreamableHTTPClientTransport(url, { authProvider: provider, requestInit })
			: new SSEClientTransport(url, { authProvider: provider, requestInit })

	const authenticate = async (): Promise<void> => {
		// M2M providers (ClientCredentialsProvider, PrivateKeyJwtProvider) don't
		// need a browser — the auth() call handles token acquisition directly.
		if (!fileProvider) {
			const result = await auth(provider, { serverUrl: url })
			if (result === "REDIRECT") {
				throw new Error("M2M provider requested a browser redirect — unexpected.")
			}
			return
		}

		// Interactive flow: use the standalone auth() orchestrator.
		// If we already have valid tokens, auth() returns AUTHORIZED immediately.
		// If not, it returns REDIRECT (after calling redirectToAuthorization,
		// which opens the browser and captures the URL).
		const serverUrlStr = url.toString()
		const result = await auth(provider, { serverUrl: serverUrlStr })

		if (result === "AUTHORIZED") return // tokens are valid

		// REDIRECT: the provider's redirectToAuthorization was called, which
		// captured the auth URL and opened the browser. Surface it to the TUI.
		const authUrl = fileProvider.getAuthUrl()
		if (intercept && authUrl) intercept.onAuthUrl(authUrl)

		// Start the callback server (the browser redirect may arrive here).
		const callbackServer = startCallbackServer(callbackPort!, (code) => fileProvider.resolveCode(code))

		try {
			let code: string
			if (intercept) {
				// Interactive: race the callback against a manual paste.
				code = await Promise.race([intercept.getCode(), fileProvider.waitForCode()])
			} else {
				code = await fileProvider.waitForCode()
			}

			// Exchange the code for tokens via the standalone auth() call.
			await auth(provider, { serverUrl: serverUrlStr, authorizationCode: code })
		} finally {
			callbackServer.close()
		}
	}

	return { transport, authenticate, provider: fileProvider }
}
