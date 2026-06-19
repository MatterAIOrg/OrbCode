import { getModel, isValidAxonModel, usesAiSdk } from "./api/models.js"
import { getAuthToken, getPendingProjectHooks, loadSettings } from "./config/settings.js"
import { Agent } from "./core/agent.js"
import type { AgentEvent } from "./core/events.js"
import { McpManager } from "./mcp/manager.js"

/** Non-interactive `orbcode -p "prompt"` mode: prints the final response to stdout. */
export async function runHeadless(prompt: string, yolo: boolean): Promise<void> {
	const settings = loadSettings()

	// An unknown --model (or MATTERAI_MODEL) silently resolves to the default; say
	// so on stderr instead of quietly running a different model than requested.
	const requestedModel = process.env.MATTERAI_MODEL
	if (requestedModel && !isValidAxonModel(requestedModel)) {
		process.stderr.write(
			`warning: unknown model "${requestedModel}"; using "${settings.model}". ` +
				`Add it under "customModels" in settings.json (with a "provider") to use it.\n`,
		)
	}

	const token = getAuthToken(settings)
	// MatterAI/Axon models authenticate with the login token. AI-SDK providers
	// (Anthropic, etc.) authenticate with their own key — resolved by the
	// provider from the env (e.g. ANTHROPIC_API_KEY) or the model's `apiKey` —
	// so they don't need a MatterAI login. Only gate on the token when the
	// selected model actually goes through the MatterAI gateway.
	if (!token && !usesAiSdk(getModel(settings.model))) {
		console.error("Not signed in. Run `orbcode login`, set MATTERAI_TOKEN, or put an apiKey in settings.json.")
		process.exit(1)
	}

	// There's no interactive trust prompt in headless mode, so untrusted project
	// hooks are skipped for safety. Tell the user how to enable them.
	const pendingHooks = getPendingProjectHooks()
	if (pendingHooks) {
		process.stderr.write(
			`note: ${pendingHooks.commands.length} project hook(s) in .orbcode/settings.json are untrusted and were skipped. ` +
				`Trust them in an interactive session, or set MATTERAI_TRUST_PROJECT_HOOKS=1.\n`,
		)
	}

	// Start MCP servers. In headless mode there's no interactive approval, so
	// project-scope servers are only connected if they were previously approved
	// (persisted in .orbcode/settings.json). Unapproved project servers are
	// skipped with a note, matching the project-hooks behavior.
	const mcp = new McpManager(
		process.cwd(),
		settings.disabledMcpServers ?? [],
		settings.enabledMcpServers ?? [],
	)
	const mcpSnapshot = await mcp.start()
	const pendingMcp = mcp.getPendingApproval()
	if (pendingMcp.length > 0) {
		process.stderr.write(
			`note: ${pendingMcp.length} project MCP server(s) in .mcp.json are unapproved and were skipped. ` +
				`Approve them in an interactive session with /mcp.\n`,
		)
	}
	const connectedMcp = mcpSnapshot.servers.filter((s) => s.status === "connected").length
	if (connectedMcp > 0) {
		process.stderr.write(`MCP: ${connectedMcp}/${mcpSnapshot.servers.length} server(s) connected.\n`)
	}

	let exitCode = 0
	// Only the final content is printed: either the attempt_completion result
	// or, failing that, the last assistant text. Intermediate text and tool
	// activity are suppressed.
	let textBuffer = ""
	let lastText = ""
	let completionResult = ""
	const agent = new Agent({
		cwd: process.cwd(),
		// May be empty for AI-SDK providers; AiSdkClient ignores it and uses the
		// provider's own key. AxonClient only runs when a token is present.
		token: token ?? "",
		modelId: settings.model,
		organizationId: settings.organizationId,
		baseUrl: settings.baseUrl,
		autoApproveEdits: yolo,
		autoApproveSafeCommands: yolo,
		hooks: settings.hooks,
		mcp,
		callbacks: {
			onEvent: (event: AgentEvent) => {
				switch (event.type) {
					case "text-delta":
						textBuffer += event.text
						break
					case "text-done":
						lastText = textBuffer
						textBuffer = ""
						break
					case "completion":
						completionResult = event.result
						break
					case "system":
						// Hook messages go to stderr so stdout stays the final answer.
						process.stderr.write(`${event.isError ? "hook error" : "hook"}: ${event.message}\n`)
						break
					case "error":
						process.stderr.write(`error: ${event.message}\n`)
						exitCode = 1
						break
				}
			},
			// In headless mode there is nobody to ask; deny unless --yolo.
			requestApproval: async (request) => {
				if (yolo) return "yes"
				process.stderr.write(`[denied] ${request.toolName}: ${request.summary} (pass --yolo to auto-approve)\n`)
				return "no"
			},
			requestFollowup: async (question) => {
				process.stderr.write(`[followup auto-answered] ${question}\n`)
				return "Proceed with your best judgment; the user is not available to answer."
			},
		},
	})

	await agent.runTurn(prompt)
	await agent.endSession("other")
	await mcp.stop().catch(() => {})
	const finalContent = completionResult || lastText || textBuffer
	if (finalContent) {
		process.stdout.write(finalContent.trimEnd() + "\n")
	}
	process.exit(exitCode)
}
