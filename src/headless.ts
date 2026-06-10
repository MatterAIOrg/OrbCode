import { getAuthToken, loadSettings } from "./config/settings.js"
import { Agent } from "./core/agent.js"
import type { AgentEvent } from "./core/events.js"

/** Non-interactive `orbcode -p "prompt"` mode: prints the final response to stdout. */
export async function runHeadless(prompt: string, yolo: boolean): Promise<void> {
	const settings = loadSettings()
	const token = getAuthToken(settings)
	if (!token) {
		console.error("Not signed in. Run `orbcode login`, set ORBCODE_TOKEN, or put an apiKey in settings.json.")
		process.exit(1)
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
		token,
		modelId: settings.model,
		organizationId: settings.organizationId,
		baseUrl: settings.baseUrl,
		autoApproveEdits: yolo,
		autoApproveSafeCommands: yolo,
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
	const finalContent = completionResult || lastText || textBuffer
	if (finalContent) {
		process.stdout.write(finalContent.trimEnd() + "\n")
	}
	process.exit(exitCode)
}
