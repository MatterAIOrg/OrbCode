import * as fs from "node:fs"
import * as path from "node:path"

import {
	AXON_MODELS,
	DEFAULT_MODEL_ID,
	canUse400kContext,
	canUseEidoBaseModels,
	canUseEidoProModels,
	canUseLumenModels,
	fetchDynamicModels,
	getDefaultModelId,
	getModel,
	is400kAxonModel,
	isEidoBaseAxonModel,
	isEidoProAxonModel,
	isLumenAxonModel,
	isValidAxonModel,
	registerCustomModels,
	usesAiSdk,
} from "./api/models.js"
import { fetchProfile } from "./auth/auth.js"
import { getAuthToken, getPendingProjectHooks, loadSettings } from "./config/settings.js"
import { Agent } from "./core/agent.js"
import type { AgentEvent } from "./core/events.js"
import { McpManager } from "./mcp/manager.js"

export interface HeadlessOptions {
	yolo: boolean
	systemPromptOverride?: string
	/** "json" emits a structured envelope; "text" (default) prints the final message. */
	outputMode?: "text" | "json"
	/** When true, exit non-zero if the requested model is not registered. */
	requireModel?: boolean
	/** Path to a file the agent should write its final structured result to. */
	outputFile?: string
	/** When true, print tool-start/tool-end events to stderr for observability. */
	verbose?: boolean
}

/**
 * Whether a tool call is the --output-file write, which headless mode approves
 * even without --yolo. Both paths are resolved so `result.json`, `./result.json`
 * and the absolute path all match, while any other target stays denied.
 */
export function isOutputFileWrite(outputFile: string | undefined, toolName: string, detail: string): boolean {
	if (!outputFile || toolName !== "file_write" || !detail) return false
	return path.resolve(detail) === path.resolve(outputFile)
}

/** Non-interactive `orbcode -p "prompt"` mode: prints the final response to stdout. */
export async function runHeadless(prompt: string, options: HeadlessOptions): Promise<void> {
	const { yolo, systemPromptOverride, outputMode = "text", requireModel, outputFile, verbose } = options
	const settings = loadSettings()
	const token = getAuthToken(settings)

	// --baseUrl / --apiKey: register a synthetic OpenAI-compatible model so the
	// request goes through the AI SDK transport instead of the MatterAI gateway.
	// Dedicated env names — MATTERAI_BASE_URL / MATTERAI_API_KEY already exist
	// and override the gateway URL / auth token (see settings.ts), so reusing
	// them would break backend calls (models list, /usage, auth).
	const customBaseUrl = process.env.MATTERAI_LLM_BASE_URL
	const customApiKey = process.env.MATTERAI_LLM_API_KEY
	if (customBaseUrl) {
		const modelId = process.env.MATTERAI_MODEL ?? "gpt-4o"
		registerCustomModels([
			{
				id: modelId,
				name: modelId,
				description: "OpenAI-compatible model via --baseUrl",
				contextWindow: 200_000,
				maxOutputTokens: 32_000,
				supportsImages: false,
				inputPrice: 0,
				outputPrice: 0,
				provider: "openai-compatible",
				baseUrl: customBaseUrl,
				apiKey: customApiKey,
			},
		])
		settings.model = modelId
		settings.modelExplicit = true
	}

	if (token && !customBaseUrl) {
		await fetchDynamicModels(token).catch(() => {})
	}

	// An unknown --model (or MATTERAI_MODEL) silently resolves to the default; say
	// so on stderr instead of quietly running a different model than requested.
	const requestedModel = process.env.MATTERAI_MODEL

	// No explicit model requested and the stored one is still the static default:
	// resolve the plan-aware default from the live catalog (free plans get the
	// catalog's free model, paid plans the first catalog entry).
	if (token && !requestedModel && !settings.modelExplicit && settings.model === DEFAULT_MODEL_ID) {
		const profile = await fetchProfile(token).catch(() => null)
		const plan = profile?.plan ?? profile?.tieredUsage?.plan
		const preferred = getDefaultModelId(plan)
		if (preferred !== settings.model) settings.model = preferred
	}
	if (requestedModel && !isValidAxonModel(requestedModel)) {
		if (requireModel || outputMode === "json") {
			// In programmatic mode, silently falling back is worse than failing fast.
			process.stderr.write(
				`error: unknown model "${requestedModel}". ` +
					`Add it under "customModels" in settings.json (with a "provider") to use it.\n`,
			)
			process.exit(1)
		}
		process.stderr.write(
			`warning: unknown model "${requestedModel}"; using "${settings.model}". ` +
				`Add it under "customModels" in settings.json (with a "provider") to use it.\n`,
		)
	}
	// MatterAI/Axon models authenticate with the login token. AI-SDK providers
	// (Anthropic, etc.) authenticate with their own key — resolved by the
	// provider from the env (e.g. ANTHROPIC_API_KEY) or the model's `apiKey` —
	// so they don't need a MatterAI login. Only gate on the token when the
	// selected model actually goes through the MatterAI gateway.
	if (!token && !usesAiSdk(getModel(settings.model)) && !customBaseUrl) {
		console.error("Not signed in. Run `orbcode login`, set MATTERAI_TOKEN, or put an apiKey in settings.json.")
		process.exit(1)
	}

	if (
		token &&
		(isLumenAxonModel(settings.model) ||
			isEidoBaseAxonModel(settings.model) ||
			isEidoProAxonModel(settings.model) ||
			is400kAxonModel(settings.model))
	) {
		const profile = await fetchProfile(token)
		const plan = profile.plan ?? profile.tieredUsage?.plan
		if (isLumenAxonModel(settings.model) && !canUseLumenModels(plan)) {
			console.error("Axon Lumen models are only available on Pro Plus and Ultra plans.")
			process.exit(1)
		}
		if (isEidoBaseAxonModel(settings.model) && !canUseEidoBaseModels(plan)) {
			console.error("Axon Eido 3.2 Code models are only available on Pro and above plans.")
			process.exit(1)
		}
		if (isEidoProAxonModel(settings.model) && !canUseEidoProModels(plan)) {
			console.error("Axon Eido 3 Pro models are only available on Pro and above plans.")
			process.exit(1)
		}
		if (is400kAxonModel(settings.model) && !canUse400kContext(plan)) {
			console.error("400k context is only available on Pro Plus and Ultra plans. Use the matching -232k model.")
			process.exit(1)
		}
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
	let usageInputTokens = 0
	let usageOutputTokens = 0
	let usageCost = 0
	let usageTotalCost = 0
	let errorMessage: string | null = null

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
		systemPromptOverride,
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
					case "usage":
						usageInputTokens += event.inputTokens
						usageOutputTokens += event.outputTokens
						usageCost += event.cost
						// totalCost is already the agent's running session total.
						usageTotalCost = event.totalCost
						break
					case "system":
						// Hook messages go to stderr so stdout stays the final answer.
						process.stderr.write(`${event.isError ? "hook error" : "hook"}: ${event.message}\n`)
						break
					case "error":
						process.stderr.write(`error: ${event.message}\n`)
						errorMessage = event.message
						exitCode = 1
						break
					case "tool-start":
						if (verbose) {
							process.stderr.write(`[tool] ${event.name}: ${event.summary}\n`)
						}
						break
					case "tool-end":
						if (verbose) {
							const status = event.isError ? "✗" : "✓"
							process.stderr.write(`[${status}] ${event.name}: ${event.summary}\n`)
						}
						break
				}
			},
			// In headless mode there is nobody to ask; deny unless --yolo.
			// Exception: writing the --output-file artifact is always allowed,
			// so read-only analysis runs can still emit a structured result.
			requestApproval: async (request) => {
				if (yolo) return "yes"
				if (isOutputFileWrite(outputFile, request.toolName, request.detail)) return "yes"
				process.stderr.write(`[denied] ${request.toolName}: ${request.summary} (pass --yolo to auto-approve)\n`)
				return "no"
			},
			requestFollowup: async (question) => {
				process.stderr.write(`[followup auto-answered] ${question}\n`)
				return "Proceed with your best judgment; the user is not available to answer."
			},
		},
	})

	// When --output-file is set, instruct the agent to write its final result
	// there via file_write. This is more reliable than parsing the chat message,
	// which weaker models truncate or mangle. The path is resolved to an
	// absolute path so the agent can't be confused by relative references.
	const effectivePrompt = outputFile
		? `${prompt}\n\n[OrbCode] When you are done, write your final answer to the file "${path.resolve(outputFile)}" using the file_write tool. Put only the final result in that file — no commentary, no markdown fences.`
		: prompt

	await agent.runTurn(effectivePrompt)
	await agent.endSession("other")
	await mcp.stop().catch(() => {})

	// Resolve the final result: prefer the output-file artifact, then
	// attempt_completion, then the last assistant text.
	let finalContent = ""
	if (outputFile) {
		const resolvedPath = path.resolve(outputFile)
		try {
			finalContent = fs.readFileSync(resolvedPath, "utf8")
		} catch {
			// File not written; fall through to completion/text.
		}
	}
	if (!finalContent) {
		finalContent = completionResult || lastText || textBuffer
	}

	if (outputMode === "json") {
		const envelope = {
			ok: exitCode === 0,
			model: settings.model,
			result: finalContent.trimEnd(),
			usage: {
				inputTokens: usageInputTokens,
				outputTokens: usageOutputTokens,
				cost: usageCost,
				totalCost: usageTotalCost,
			},
			sessionId: agent.taskId,
			error: errorMessage,
		}
		process.stdout.write(JSON.stringify(envelope) + "\n")
	} else if (finalContent) {
		process.stdout.write(finalContent.trimEnd() + "\n")
	}

	process.stderr.write(`\nSession saved. To resume: orbcode --resume ${agent.taskId}\n`)
	// process.exit() drops pending async writes (piped stdout is async on macOS),
	// which would truncate `--json | jq`; exit only once both streams drain.
	await Promise.all([flush(process.stdout), flush(process.stderr)])
	process.exit(exitCode)
}

function flush(stream: NodeJS.WriteStream): Promise<void> {
	return new Promise((resolve) => stream.write("", () => resolve()))
}
