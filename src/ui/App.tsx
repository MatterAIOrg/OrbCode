import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Static, Text, useApp, useInput } from "ink"
import open from "open"

import { COLORS, VERSION } from "../branding.js"
import { AXON_MODELS, getModel, isValidAxonModel } from "../api/models.js"
import { LoginView } from "./LoginView.js"
import { APP_URL, fetchBalance, fetchProfile, fetchTaskTitle, type ProfileData } from "../auth/auth.js"
import { getAuthToken, loadSettings, saveSettings, type OrbCodeSettings } from "../config/settings.js"
import { Agent } from "../core/agent.js"
import type {
	AgentEvent,
	ApprovalDecision,
	ApprovalRequest,
	FollowupSuggestion,
} from "../core/events.js"
import { Spinner } from "./components/Spinner.js"
import { InputBox, type SlashCommand } from "./components/InputBox.js"
import { ApprovalPrompt } from "./components/ApprovalPrompt.js"
import { FollowupPrompt } from "./components/FollowupPrompt.js"
import { StatusBar, type ApprovalMode } from "./components/StatusBar.js"
import { ModelPicker } from "./components/ModelPicker.js"
import { SessionPicker } from "./components/SessionPicker.js"
import { listSessions, type SessionData } from "../core/sessions.js"
import { RowView, formatToolName, type Row } from "./components/rows.js"

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "/help", description: "show available commands" },
	{ name: "/model", description: "select the Axon model to use" },
	{ name: "/clear", description: "clear the screen — the conversation continues" },
	{ name: "/new", description: "start a new conversation with a clean slate" },
	{ name: "/resume", description: "resume a previous session" },
	{ name: "/compact", description: "summarize the conversation to free up context" },
	{ name: "/tasks", description: "show the current task list" },
	{ name: "/status", description: "show session status (model, context, cost, account)" },
	{ name: "/cost", description: "show session cost and balance" },
	{ name: "/init", description: "analyze this codebase and create an AGENTS.md" },
	{ name: "/analytics", description: "open your MatterAI analytics dashboard" },
	{ name: "/login", description: "sign in to MatterAI" },
	{ name: "/logout", description: "sign out and remove the saved token" },
	{ name: "/version", description: "show the OrbCode CLI version" },
	{ name: "/exit", description: "quit OrbCode CLI" },
]

function setTerminalTitle(title: string): void {
	if (process.stdout.isTTY) {
		process.stdout.write(`\x1b]0;${title}\x07`)
	}
}

/** Human lines for the /status and /cost usage block (extension profile data). */
function usageLines(profile: ProfileData): string[] {
	const lines: string[] = []
	if (profile.plan) lines.push(`Plan        ${profile.plan}`)
	if (typeof profile.usagePercentage === "number") {
		lines.push(
			`Usage       ${profile.usagePercentage}% used · ${Math.max(0, 100 - profile.usagePercentage)}% remaining`,
		)
	}
	if (typeof profile.remainingReviews === "number") {
		lines.push(`Reviews     ${profile.remainingReviews} remaining`)
	}
	if (profile.creditsResetDate) lines.push(`Resets      ${profile.creditsResetDate}`)
	return lines
}

const INIT_PROMPT = `Analyze this codebase and create an AGENTS.md file containing:
1. A short overview of what the project does
2. Build, run, lint and test commands
3. Architecture and code structure (key directories and what lives in them)
4. Code style conventions used in this repo (imports, formatting, naming, error handling)

If an AGENTS.md already exists, improve it. Keep it under ~60 lines so it is cheap to include in future prompts.`

interface PendingApproval {
	request: ApprovalRequest
	resolve: (decision: ApprovalDecision) => void
}

interface PendingFollowup {
	question: string
	suggestions: FollowupSuggestion[]
	resolve: (answer: string) => void
}

interface RunningTool {
	id: string
	name: string
	summary: string
}

let rowCounter = 0
function rowId(): string {
	return `row-${rowCounter++}`
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never

export function App({
	initialView,
	initialPrompt,
	initialSession,
}: {
	initialView?: "login" | "chat"
	initialPrompt?: string
	initialSession?: SessionData
}) {
	const { exit } = useApp()
	const [settings, setSettings] = useState<OrbCodeSettings>(() => loadSettings())
	const [view, setView] = useState<"login" | "chat">(initialView ?? (getAuthToken(settings) ? "chat" : "login"))

	const [rows, setRows] = useState<Row[]>(() => [
		{ kind: "header", id: "header", cwd: process.cwd(), modelName: getModel(loadSettings().model).name },
	])
	const [busy, setBusy] = useState(false)
	const [busyLabel, setBusyLabel] = useState("Thinking")
	const [streamingReasoning, setStreamingReasoning] = useState("")
	const [streamingText, setStreamingText] = useState("")
	const [runningTool, setRunningTool] = useState<RunningTool | null>(null)
	const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null)
	const [pendingFollowup, setPendingFollowup] = useState<PendingFollowup | null>(null)
	const [modelPickerOpen, setModelPickerOpen] = useState(false)
	const [resumableSessions, setResumableSessions] = useState<SessionData[] | null>(null)
	const [staticKey, setStaticKey] = useState(0)
	const [tasks, setTasks] = useState("")
	const [contextTokens, setContextTokens] = useState(0)
	const [totalCost, setTotalCost] = useState(0)
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() =>
		settings.autoApproveEdits && settings.autoApproveSafeCommands
			? "auto"
			: settings.autoApproveEdits
				? "edits"
				: "ask",
	)

	const [sessionTitle, setSessionTitle] = useState("")
	const [usage, setUsage] = useState<{ plan?: string; usagePercentage?: number } | null>(null)

	// Refresh plan/usage from /axoncode/profile (shown below the chat box).
	const refreshUsage = useCallback(() => {
		const token = getAuthToken(loadSettings())
		if (!token) return
		fetchProfile(token)
			.then((profile) => setUsage({ plan: profile.plan, usagePercentage: profile.usagePercentage }))
			.catch(() => {})
	}, [])

	const agentRef = useRef<Agent | null>(null)
	const expandReasoningRef = useRef(false)
	const reasoningBufferRef = useRef("")
	const textBufferRef = useRef("")
	// taskId for which a title fetch has already been started (once per task).
	const titleTaskRef = useRef<string | null>(null)

	const maybeFetchTitle = useCallback(() => {
		const agent = agentRef.current
		if (!agent || titleTaskRef.current === agent.taskId) return
		titleTaskRef.current = agent.taskId
		const token = getAuthToken(loadSettings())
		if (!token) return
		void fetchTaskTitle(agent.taskId, token).then((title) => {
			if (title && agentRef.current?.taskId === agent.taskId) {
				setSessionTitle(title)
				setTerminalTitle(`${title} (orbcode)`)
				agent.setTitle(title)
			}
		})
	}, [])

	const pushRow = useCallback((row: DistributiveOmit<Row, "id">) => {
		setRows((prev) => [...prev, { ...row, id: rowId() } as Row])
	}, [])

	// Wipe the visible transcript and remount <Static> with just the header —
	// a clean slate for /clear, /new and /resume.
	const resetTranscript = useCallback(() => {
		if (process.stdout.isTTY) {
			process.stdout.write("\x1b[2J\x1b[H")
		}
		setRows([
			{ kind: "header", id: rowId(), cwd: process.cwd(), modelName: getModel(loadSettings().model).name },
		])
		setStaticKey((k) => k + 1)
	}, [])

	const handleEvent = useCallback(
		(event: AgentEvent) => {
			switch (event.type) {
				case "reasoning-delta":
					reasoningBufferRef.current += event.text
					setStreamingReasoning(reasoningBufferRef.current)
					setBusyLabel("Thinking")
					break
				case "reasoning-done":
					pushRow({
						kind: "reasoning",
						text: reasoningBufferRef.current,
						durationMs: event.durationMs,
						expanded: expandReasoningRef.current,
					})
					reasoningBufferRef.current = ""
					setStreamingReasoning("")
					break
				case "text-delta":
					textBufferRef.current += event.text
					setStreamingText(textBufferRef.current)
					setBusyLabel("Responding")
					break
				case "text-done":
					pushRow({ kind: "assistant", text: textBufferRef.current })
					textBufferRef.current = ""
					setStreamingText("")
					break
				case "tool-start":
					setRunningTool({ id: event.id, name: event.name, summary: event.summary })
					setBusyLabel(`Running ${event.name}`)
					break
				case "tool-end":
					setRunningTool(null)
					setBusyLabel("Thinking")
					pushRow({
						kind: "tool",
						name: event.name,
						summary: event.summary,
						resultPreview: event.resultPreview,
						isError: event.isError,
						diff: event.diff,
					})
					break
				case "todos":
					setTasks(event.todos)
					break
				case "usage":
					setContextTokens(event.inputTokens + event.outputTokens)
					setTotalCost(event.totalCost)
					break
				case "completion":
					pushRow({ kind: "completion", text: event.result })
					break
				case "error":
					pushRow({ kind: "error", text: event.message })
					break
				case "turn-end":
					// Flush anything still streaming (e.g. on interrupt).
					if (textBufferRef.current) {
						pushRow({ kind: "assistant", text: textBufferRef.current })
						textBufferRef.current = ""
						setStreamingText("")
					}
					if (reasoningBufferRef.current) {
						reasoningBufferRef.current = ""
						setStreamingReasoning("")
					}
					setRunningTool(null)
					setBusy(false)
					maybeFetchTitle()
					refreshUsage()
					break
			}
		},
		[pushRow, maybeFetchTitle, refreshUsage],
	)

	const createAgent = useCallback(
		(resume?: SessionData): Agent => {
			const current = loadSettings()
			return new Agent({
				cwd: process.cwd(),
				token: getAuthToken(current)!,
				modelId: current.model,
				organizationId: current.organizationId,
				baseUrl: current.baseUrl,
				autoApproveEdits: current.autoApproveEdits,
				autoApproveSafeCommands: current.autoApproveSafeCommands,
				resume,
				callbacks: {
					onEvent: handleEvent,
					requestApproval: (request) =>
						new Promise<ApprovalDecision>((resolve) => setPendingApproval({ request, resolve })),
					requestFollowup: (question, suggestions) =>
						new Promise<string>((resolve) => setPendingFollowup({ question, suggestions, resolve })),
				},
			})
		},
		[handleEvent],
	)

	const getAgent = useCallback((): Agent => {
		if (!agentRef.current) {
			agentRef.current = createAgent()
		}
		return agentRef.current
	}, [createAgent])

	const handleResume = useCallback(
		(session: SessionData) => {
			setResumableSessions(null)
			agentRef.current = createAgent(session)
			resetTranscript()
			setTasks(session.todos ?? "")
			setTotalCost(session.totalCost ?? 0)
			if (session.title) {
				// The stored title is already the backend one (or the prompt
				// fallback); don't re-fetch for this task.
				titleTaskRef.current = session.id
				setSessionTitle(session.title)
				setTerminalTitle(`${session.title} (orbcode)`)
			}
			// Replay the conversation into the transcript.
			for (const message of session.messages) {
				if (message.role === "user" && typeof message.content === "string") {
					const match = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(message.content)
					if (match) pushRow({ kind: "user", text: match[1] })
				} else if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
					pushRow({ kind: "assistant", text: message.content })
				}
			}
			pushRow({ kind: "info", text: `Resumed session: ${session.title || session.id}` })
		},
		[createAgent, pushRow, resetTranscript],
	)

	const switchModel = useCallback(
		(modelId: string) => {
			const updated = { ...loadSettings(), model: modelId }
			setSettings(updated)
			saveSettings(updated)
			agentRef.current?.setModel(modelId)
			pushRow({ kind: "info", text: `Model switched to ${getModel(modelId).name}` })
		},
		[pushRow],
	)

	const handleCommand = useCallback(
		(command: string) => {
			const [name, ...rest] = command.split(/\s+/)
			const arg = rest.join(" ")
			switch (name) {
				case "/help":
					pushRow({
						kind: "info",
						text: SLASH_COMMANDS.map((c) => `${c.name.padEnd(12)} ${c.description}`).join("\n"),
					})
					break
				case "/model": {
					const ids = Object.keys(AXON_MODELS)
					if (arg && isValidAxonModel(arg)) {
						switchModel(arg)
					} else if (arg && isValidAxonModel(`axon-code-2-5-${arg}`)) {
						switchModel(`axon-code-2-5-${arg}`)
					} else if (arg) {
						pushRow({ kind: "error", text: `Unknown model "${arg}". Available: ${ids.join(", ")}` })
					} else {
						setModelPickerOpen(true)
					}
					break
				}
				case "/clear":
					// Like the terminal's `clear`: wipe the view only. The
					// conversation, session and context all continue.
					resetTranscript()
					break
				case "/new":
					// Drop the agent entirely so the next message starts a fresh session.
					agentRef.current = null
					titleTaskRef.current = null
					setSessionTitle("")
					setTerminalTitle("orbcode")
					setTasks("")
					setContextTokens(0)
					resetTranscript()
					break
				case "/analytics": {
					const url = `${APP_URL}/orbital`
					pushRow({ kind: "info", text: `Opening analytics: ${url}` })
					void open(url).catch(() => {})
					break
				}
				case "/resume": {
					const sessions = listSessions(process.cwd()).filter((s) => s.id !== agentRef.current?.taskId)
					if (sessions.length === 0) {
						pushRow({ kind: "info", text: "No previous sessions found for this directory." })
						break
					}
					setResumableSessions(sessions)
					break
				}
				case "/compact":
					if (!getAuthToken(settings)) {
						setView("login")
						break
					}
					setBusy(true)
					setBusyLabel("Compacting")
					void getAgent().compact()
					break
				case "/tasks":
					pushRow({
						kind: "info",
						text: tasks.trim() ? `Tasks\n${tasks}` : "No tasks yet.",
					})
					break
				case "/status": {
					const model = getModel(settings.model)
					const contextPct = Math.min(100, Math.round((contextTokens / model.contextWindow) * 100))
					pushRow({
						kind: "info",
						text: [
							`Version     ${VERSION}`,
							`Model       ${model.name} (${model.id})`,
							`Directory   ${process.cwd()}`,
							`Account     ${getAuthToken(settings) ? (settings.apiKey || process.env.ORBCODE_TOKEN ? "API key" : "signed in") : "signed out"}${settings.organizationId ? ` · org ${settings.organizationId}` : ""}`,
							`Gateway     ${settings.baseUrl ?? "MatterAI (default)"}`,
							`Context     ${contextTokens.toLocaleString()} / ${model.contextWindow.toLocaleString()} tokens (${contextPct}%)`,
							`Cost        $${totalCost.toFixed(4)} this session`,
							`Approvals   edits ${settings.autoApproveEdits ? "auto" : "ask"} · safe commands ${settings.autoApproveSafeCommands ? "auto" : "ask"}`,
							...(sessionTitle ? [`Task        ${sessionTitle}`] : []),
						].join("\n"),
					})
					const statusToken = getAuthToken(settings)
					if (statusToken) {
						fetchProfile(statusToken)
							.then((profile) => {
								const lines = usageLines(profile)
								if (lines.length > 0) pushRow({ kind: "info", text: lines.join("\n") })
							})
							.catch(() => {})
					}
					break
				}
				case "/init":
					if (!getAuthToken(settings)) {
						setView("login")
						break
					}
					pushRow({ kind: "user", text: "/init" })
					setBusy(true)
					setBusyLabel("Thinking")
					void getAgent().runTurn(INIT_PROMPT)
					break
				case "/version":
					pushRow({ kind: "info", text: `OrbCode CLI v${VERSION}` })
					break
				case "/cost": {
					pushRow({ kind: "info", text: `Session cost: $${totalCost.toFixed(4)} (fetching balance…)` })
					const token = getAuthToken(settings)
					if (token) {
						fetchBalance(token, settings.organizationId).then((balance) => {
							if (balance !== undefined) {
								pushRow({ kind: "info", text: `Account balance: $${balance.toFixed(2)}` })
							}
						})
						fetchProfile(token)
							.then((profile) => {
								const lines = usageLines(profile)
								if (lines.length > 0) pushRow({ kind: "info", text: lines.join("\n") })
							})
							.catch(() => {})
					}
					break
				}
				case "/login":
					setView("login")
					break
				case "/logout": {
					const updated = { ...settings, token: undefined }
					setSettings(updated)
					saveSettings(updated)
					agentRef.current = null
					setView("login")
					break
				}
				case "/exit":
					exit()
					break
				default:
					pushRow({ kind: "error", text: `Unknown command: ${name}. Try /help.` })
			}
		},
		[settings, tasks, contextTokens, totalCost, sessionTitle, exit, pushRow, getAgent, switchModel, resetTranscript],
	)

	const handleSubmit = useCallback(
		(value: string) => {
			if (value.startsWith("/")) {
				handleCommand(value)
				return
			}
			if (!getAuthToken(settings)) {
				setView("login")
				return
			}
			pushRow({ kind: "user", text: value })
			setBusy(true)
			setBusyLabel("Thinking")
			void getAgent().runTurn(value)
		},
		[settings.token, handleCommand, getAgent, pushRow],
	)

	// Apply --resume and an initial prompt (`orbcode "do something"`) on startup.
	const bootedRef = useRef(false)
	useEffect(() => {
		if (bootedRef.current) return
		bootedRef.current = true
		if (initialSession) handleResume(initialSession)
		if (initialPrompt) handleSubmit(initialPrompt)
		refreshUsage()
	}, [initialSession, initialPrompt, handleResume, handleSubmit, refreshUsage])

	useInput((input, key) => {
		if (key.escape && busy && !pendingApproval && !pendingFollowup) {
			agentRef.current?.abort()
		}
		if (key.tab && key.shift) {
			setApprovalMode((prev) => {
				const next: ApprovalMode = prev === "ask" ? "edits" : prev === "edits" ? "auto" : "ask"
				const autoApproveEdits = next !== "ask"
				const autoApproveSafeCommands = next === "auto"
				const updated = { ...loadSettings(), autoApproveEdits, autoApproveSafeCommands }
				setSettings(updated)
				saveSettings(updated)
				agentRef.current?.setApprovalMode(autoApproveEdits, autoApproveSafeCommands)
				return next
			})
		}
		if (key.ctrl && input === "o") {
			const expanded = !expandReasoningRef.current
			expandReasoningRef.current = expanded
			// Re-render the whole transcript (including past thinking) with the
			// new expansion state: clear the screen and remount <Static>.
			setRows((prev) => prev.map((row) => (row.kind === "reasoning" ? { ...row, expanded } : row)))
			if (process.stdout.isTTY) {
				process.stdout.write("\x1b[2J\x1b[H")
			}
			setStaticKey((k) => k + 1)
		}
	})

	const handleLogin = useCallback(
		(token: string, profile: ProfileData) => {
			const updated = { ...loadSettings(), token }
			setSettings(updated)
			saveSettings(updated)
			agentRef.current = null
			setView("chat")
			setUsage({ plan: profile.plan, usagePercentage: profile.usagePercentage })
			const who = profile.user?.name || profile.user?.email
			pushRow({ kind: "info", text: `Signed in${who ? ` as ${who}` : ""}. Ready when you are.` })
		},
		[pushRow],
	)

	const taskLines = useMemo(
		() => tasks.split("\n").map((l) => l.trim()).filter(Boolean),
		[tasks],
	)

	const inputActive =
		view === "chat" && !busy && !pendingApproval && !pendingFollowup && !modelPickerOpen && !resumableSessions

	return (
		<Box flexDirection="column">
			<Static key={staticKey} items={rows}>
				{(row) => <RowView key={row.id} row={row} />}
			</Static>

			{view === "login" ? (
				<LoginSection onLogin={handleLogin} />
			) : (
				<Box flexDirection="column">
					{streamingReasoning && (
						<Box flexDirection="column" marginTop={1}>
							<Text color={COLORS.thinking} italic>
								✦ Thinking…
							</Text>
							<Box paddingLeft={2}>
								<Text dimColor italic>
									{tail(streamingReasoning, expandReasoningRef.current ? 30 : 3)}
								</Text>
							</Box>
						</Box>
					)}
					{streamingText && (
						<Box marginTop={1}>
							<Text>
								<Text color={COLORS.primary}>● </Text>
								{streamingText}
							</Text>
						</Box>
					)}
					{runningTool && (
						<Box marginTop={1}>
							<Text color={COLORS.warning}>
								{formatToolName(runningTool.name)} <Text dimColor>{runningTool.summary}</Text>
							</Text>
						</Box>
					)}
					{taskLines.length > 0 && (
						<Box flexDirection="column" marginTop={1} paddingLeft={1}>
							<Text dimColor bold>
								Tasks
							</Text>
							{taskLines.slice(0, 10).map((line, i) => (
								<Text key={i} dimColor={/^[-*]\s*\[x\]/i.test(line)}>
									{line
										.replace(/^[-*]\s*\[x\]/i, "  ■")
										.replace(/^[-*]\s*\[-\]/, "  ◧")
										.replace(/^[-*]\s*\[ \]/, "  □")}
								</Text>
							))}
							{taskLines.length > 10 && <Text dimColor> … {taskLines.length - 10} more</Text>}
						</Box>
					)}
					{modelPickerOpen && (
						<Box marginTop={1}>
							<ModelPicker
								currentId={settings.model}
								onSelect={(modelId) => {
									setModelPickerOpen(false)
									switchModel(modelId)
								}}
								onCancel={() => setModelPickerOpen(false)}
							/>
						</Box>
					)}
					{resumableSessions && (
						<Box marginTop={1}>
							<SessionPicker
								sessions={resumableSessions}
								onSelect={handleResume}
								onCancel={() => setResumableSessions(null)}
							/>
						</Box>
					)}
					{pendingApproval && (
						<Box marginTop={1}>
							<ApprovalPrompt
								request={pendingApproval.request}
								onDecision={(decision) => {
									pendingApproval.resolve(decision)
									setPendingApproval(null)
								}}
							/>
						</Box>
					)}
					{pendingFollowup && (
						<Box marginTop={1}>
							<FollowupPrompt
								question={pendingFollowup.question}
								suggestions={pendingFollowup.suggestions}
								onAnswer={(answer) => {
									pushRow({ kind: "user", text: answer })
									pendingFollowup.resolve(answer)
									setPendingFollowup(null)
								}}
							/>
						</Box>
					)}
					{busy && !pendingApproval && !pendingFollowup && !streamingText && (
						<Box marginTop={1}>
							<Spinner label={busyLabel} />
						</Box>
					)}
					<Box marginTop={1} flexDirection="column">
						<InputBox active={inputActive} slashCommands={SLASH_COMMANDS} onSubmit={handleSubmit} />
						<StatusBar
							modelId={settings.model}
							contextTokens={contextTokens}
							totalCost={totalCost}
							state={busy ? busyLabel : ""}
							approvalMode={approvalMode}
							busy={busy}
							title={sessionTitle}
							plan={usage?.plan}
							usagePercentage={usage?.usagePercentage}
						/>
					</Box>
				</Box>
			)}
		</Box>
	)
}

function tail(text: string, lines: number): string {
	const all = text.split("\n").filter((l) => l.trim())
	return all.slice(-lines).join("\n")
}

function LoginSection({ onLogin }: { onLogin: (token: string, profile: ProfileData) => void }) {
	return <LoginView onLogin={onLogin} />
}
