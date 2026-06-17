import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Box, Static, Text, useApp, useInput } from "ink"
import open from "open"

import { COLORS, VERSION } from "../branding.js"
import { AXON_MODELS, getModel, isValidAxonModel } from "../api/models.js"
import { LoginView } from "./LoginView.js"
import { APP_URL, fetchBalance, fetchProfile, fetchTaskTitle, type ProfileData } from "../auth/auth.js"
import {
	getAuthToken,
	getPendingProjectHooks,
	loadSettings,
	saveSettings,
	trustProjectHooks,
	type OrbCodeSettings,
} from "../config/settings.js"
import { Agent } from "../core/agent.js"
import type { UpdateInfo } from "../utils/updateCheck.js"
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
import { HookTrustPrompt } from "./components/HookTrustPrompt.js"
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
	{ name: "/commit", description: "check pending changes and create detailed commits" },
	{ name: "/code-review", description: "expert review of pending changes: performance, security, bugs, tests" },
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

function formatRelativeTime(isoStr?: string): string {
	if (!isoStr) return "???"
	const now = Date.now()
	const target = new Date(isoStr).getTime()
	if (Number.isNaN(target)) return "???"
	const diff = target - now
	if (diff <= 0) return "now"
	const sec = Math.floor(diff / 1000)
	const min = Math.floor(sec / 60)
	const hrs = Math.floor(min / 60)
	const days = Math.floor(hrs / 24)
	if (days >= 1) return `in ${days} day${days > 1 ? "s" : ""}`
	if (hrs >= 1) return `in ${hrs}h ${min % 60}m`
	if (min >= 1) return `in ${min}m`
	return "soon"
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
	if (profile.tieredUsage) {
		const ws: [string, string, import("../auth/auth.js").AxonCodeWindowUsage][] = [
			["5hr", "5-Hour", profile.tieredUsage.fiveHour],
			["wk",  "Weekly", profile.tieredUsage.weekly],
			["mo",  "Monthly", profile.tieredUsage.monthly],
		]
		for (const [short, label, w] of ws) {
			const remaining = Math.max(0, w.remaining || 0)
			const pct = Math.max(0, Math.min(100, w.percentage || 0))
			const reset = formatRelativeTime(w.resetsAt)
			lines.push(
				`${label.padEnd(12)} ${remaining.toFixed(1)}/${w.limit.toFixed(1)} left (${pct}% used) · Resets ${reset}`,
			)
		}
	} else if (profile.creditsResetDate) {
		lines.push(`Resets      ${profile.creditsResetDate}`)
	}
	return lines
}

const INIT_PROMPT = `Analyze this codebase and create an AGENTS.md file containing:
1. A short overview of what the project does
2. Build, run, lint and test commands
3. Architecture and code structure (key directories and what lives in them)
4. Code style conventions used in this repo (imports, formatting, naming, error handling)

If an AGENTS.md already exists, improve it. Keep it under ~60 lines so it is cheap to include in future prompts.`

// Ported from the Orbital extension's commit slash command (commitCommandResponse).
const buildCommitPrompt = (userInput: string) => `The user has explicitly asked you to check pending changes and generate detailed commit messages. You MUST now help them with this.

Please check all the pending changes in the git repository and generate detailed commit messages. If needed, you can split into multiple commits also.

Instructions:
1. First, check all pending changes using git status and git diff
2. Group related changes together logically (e.g., a feature implementation, a bug fix, refactoring, etc.)
3. For each logical group, generate a detailed, conventional commit message following the format:
   type(scope): short description

   Detailed explanation of what changed and why
4. Create separate commits for each logical group using git add and git commit
5. For GitHub repositories only, attribute the commit author as: matterai-app[bot]

To detect if the repository is hosted on GitHub, check the remote URL using:
  git remote get-url origin

If the remote URL contains "github.com", use the author flag:
  git commit --author="matterai-app[bot] <matterai-app[bot]@users.noreply.github.com>"

Before committing, present the commit messages to the user for review and ask them to confirm before executing.${userInput ? `\n\nThe user provided the following input with the commit command:\n${userInput}` : ""}`

const buildCodeReviewPrompt = (userInput: string) => `The user has explicitly asked you to perform a thorough code review of the pending changes. You MUST now help them with this.

Review the code as a panel of four experts. Adopt each expert persona fully, one at a time, and review the complete change set from that specialty before moving on to the next:

1. Performance Expert — algorithmic complexity, redundant computation or I/O, N+1 queries, unnecessary allocations, blocking calls on hot paths, missed caching or batching opportunities, and memory leaks.
2. Security Expert — injection (SQL/command/path), unsafe deserialization, missing input validation or sanitization, secrets or credentials in code, authentication/authorization gaps, unsafe defaults, and risky dependency usage.
3. Bug Hunter — logic errors, off-by-one mistakes, null/undefined handling, unhandled errors and rejected promises, race conditions, incorrect edge-case behavior, type coercion pitfalls, and broken assumptions between callers and callees.
4. Test Expert — missing or inadequate test coverage for the changed behavior, untested edge cases and error paths, assertions that don't verify the actual behavior, and brittle or flaky test patterns; propose specific test cases worth adding.

Instructions:
1. First, gather the changes to review: use git status and git diff (including staged changes). If the working tree is clean, review the most recent commit instead.
2. Read the surrounding code of the changed files whenever you need more context for a finding — do not judge a diff hunk in isolation.
3. Report findings grouped per expert. For each finding include: severity (critical / major / minor), the file and line, what is wrong, why it matters, and a concrete suggested fix.
4. Only report real findings. If an expert finds nothing significant, state that explicitly — do not invent issues to fill space.
5. Finish with a short summary: all findings ordered by severity, and an overall verdict on whether the changes are safe to merge.

This is a review only — do NOT modify any files. Present the findings to the user.${userInput ? `\n\nThe user provided the following input with the code-review command:\n${userInput}` : ""}`

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
	updateCheck,
}: {
	initialView?: "login" | "chat"
	initialPrompt?: string
	initialSession?: SessionData
	/** Promise resolving to the latest-npm-version comparison; resolved after first paint. */
	updateCheck?: Promise<UpdateInfo>
}) {
	const { exit } = useApp()
	const [settings, setSettings] = useState<OrbCodeSettings>(() => loadSettings())
	const [view, setView] = useState<"login" | "chat">(initialView ?? (getAuthToken(settings) ? "chat" : "login"))
	const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)

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
	// Set when the current project defines hooks that haven't been trusted yet;
	// gates input until the user decides (project hooks run shell commands).
	const [pendingHookTrust, setPendingHookTrust] = useState<{ commands: string[] } | null>(null)
	// FIFO queue of messages the user typed while the LLM was still streaming.
	// Drained one-per-turn on each `turn-end` event so multi-step work can
	// keep flowing without making the user wait for the previous response.
	const [queuedMessages, setQueuedMessages] = useState<string[]>([])
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
	const [usage, setUsage] = useState<{ plan?: string; usagePercentage?: number; tieredUsage?: import("../auth/auth.js").AxonCodeTieredUsage } | null>(null)

	// Refresh plan/usage from /axoncode/profile (shown below the chat box).
	const refreshUsage = useCallback(() => {
		const token = getAuthToken(loadSettings())
		if (!token) return
		fetchProfile(token)
			.then((profile) =>
				setUsage({ plan: profile.plan, usagePercentage: profile.usagePercentage, tieredUsage: profile.tieredUsage }),
			)
			.catch(() => {})
	}, [])

	const agentRef = useRef<Agent | null>(null)
	const expandReasoningRef = useRef(false)
	const reasoningBufferRef = useRef("")
	const textBufferRef = useRef("")
	// taskId for which a title fetch has already been started (once per task).
	const titleTaskRef = useRef<string | null>(null)
	// Mirror of `queuedMessages` for the agent event handler (kept on a ref so
	// we can drain it inside `handleEvent` without re-creating that callback
	// on every keystroke).
	const queueRef = useRef<string[]>([])
	// Holds the startup prompt while we wait for a project-hook trust decision.
	const deferredPromptRef = useRef<string | null>(null)
	// Guards endAndExit against double-invocation (Ctrl+D spam).
	const exitingRef = useRef(false)

	const enqueueMessage = useCallback((text: string) => {
		queueRef.current = [...queueRef.current, text]
		setQueuedMessages(queueRef.current)
	}, [])

	const drainQueue = useCallback((): string | null => {
		if (queueRef.current.length === 0) return null
		const [next, ...rest] = queueRef.current
		queueRef.current = rest
		setQueuedMessages(rest)
		return next
	}, [])

	const clearQueue = useCallback(() => {
		queueRef.current = []
		setQueuedMessages([])
	}, [])

	const maybeFetchTitle = useCallback(() => {
		const agent = agentRef.current
		if (!agent || titleTaskRef.current === agent.taskId) return
		titleTaskRef.current = agent.taskId
		const token = getAuthToken(loadSettings())
		if (!token) return
		void fetchTaskTitle(agent.taskId, token).then((title) => {
			if (title && agentRef.current?.taskId === agent.taskId) {
				setSessionTitle(title)
				setTerminalTitle(title)
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
					// A usage chunk arrives once per LLM response, so the plan/usage
					// shown below the chat box stays current mid-turn, not only
					// after the turn finishes.
					refreshUsage()
					break
				case "completion":
					pushRow({ kind: "completion", text: event.result })
					break
				case "system":
					pushRow({ kind: event.isError ? "error" : "info", text: event.message })
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
					// Pop the next queued message and immediately start a new
					// turn on top of the one that just ended. The agent's
					// `runTurn` is fully resolved at this point (its
					// `finally` emitted this event), so the new turn picks
					// up the up-to-date conversation history. We use
					// `agentRef` directly here to avoid a circular
					// `handleEvent` ↔ `getAgent` reference; the ref is
					// guaranteed populated because `runTurn` set it
					// synchronously before emitting this event.
					const nextQueued = drainQueue()
					if (nextQueued !== null && agentRef.current) {
						pushRow({ kind: "user", text: nextQueued })
						setBusy(true)
						setBusyLabel("Thinking")
						void agentRef.current.runTurn(nextQueued)
					}
					break
			}
		},
		[pushRow, maybeFetchTitle, refreshUsage, drainQueue],
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
				hooks: current.hooks,
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
			// Repopulate the status bar immediately. Without this the context
			// number only appears once the next streaming `usage` chunk arrives,
			// which can be after several seconds of "ctx 0".
			setContextTokens(session.contextTokens ?? 0)
			if (session.title) {
				// The stored title is already the backend one (or the prompt
				// fallback); don't re-fetch for this task.
				titleTaskRef.current = session.id
				setSessionTitle(session.title)
				setTerminalTitle(session.title)
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

	// Fire SessionEnd hooks (best-effort, capped at 3s) before quitting.
	const endAndExit = useCallback(
		(reason: string) => {
			const agent = agentRef.current
			if (!agent) {
				exit()
				return
			}
			// Guard against double-invocation (e.g. the user spamming Ctrl+D):
			// the first call schedules the shutdown; subsequent calls are no-ops.
			if (exitingRef.current) return
			exitingRef.current = true
			// Clear the cap timer when SessionEnd finishes first — Promise.race
			// leaves the loser pending, and a ref'd setTimeout would otherwise
			// keep the event loop alive (delaying the actual exit by up to 3s).
			let capTimer: ReturnType<typeof setTimeout> | undefined
			const cap = new Promise<void>((resolve) => {
				capTimer = setTimeout(resolve, 3000)
				capTimer.unref?.()
			})
			void Promise.race([agent.endSession(reason), cap]).finally(() => {
				if (capTimer) clearTimeout(capTimer)
				agent.abort()
				exit()
			})
		},
		[exit],
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
					} else if (arg) {
						// Allow short suffixes like "pro" or "mini" to resolve to the
						// latest matching registered id, so /model pro keeps working
						// as new model generations are added.
						const matches = ids
							.filter((id) => id.endsWith(`-${arg}`))
							.sort()
							.reverse()
						if (matches.length > 0) {
							switchModel(matches[0])
						} else {
							pushRow({ kind: "error", text: `Unknown model "${arg}". Available: ${ids.join(", ")}` })
						}
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
					clearQueue()
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
							`Account     ${getAuthToken(settings) ? (settings.apiKey || process.env.MATTERAI_TOKEN ? "API key" : "signed in") : "signed out"}${settings.organizationId ? ` · org ${settings.organizationId}` : ""}`,
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
				case "/commit":
					if (!getAuthToken(settings)) {
						setView("login")
						break
					}
					pushRow({ kind: "user", text: command })
					setBusy(true)
					setBusyLabel("Thinking")
					void getAgent().runTurn(buildCommitPrompt(arg))
					break
				case "/code-review":
					if (!getAuthToken(settings)) {
						setView("login")
						break
					}
					pushRow({ kind: "user", text: command })
					setBusy(true)
					setBusyLabel("Reviewing")
					void getAgent().runTurn(buildCodeReviewPrompt(arg))
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
					clearQueue()
					void agentRef.current?.endSession("logout")
					setPendingHookTrust(null)
					deferredPromptRef.current = null
					const updated = { ...settings, token: undefined }
					setSettings(updated)
					saveSettings(updated)
					agentRef.current = null
					setView("login")
					break
				}
				case "/exit":
					endAndExit("prompt_input_exit")
					break
				default:
					pushRow({ kind: "error", text: `Unknown command: ${name}. Try /help.` })
			}
		},
		[settings, tasks, contextTokens, totalCost, sessionTitle, endAndExit, pushRow, getAgent, switchModel, resetTranscript, clearQueue],
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
			// While the LLM is still streaming, hold the message in a FIFO
			// queue instead of dropping it on the floor. `handleEvent`'s
			// `turn-end` case drains the queue and starts the next turn.
			if (busy) {
				enqueueMessage(value)
				return
			}
			pushRow({ kind: "user", text: value })
			setBusy(true)
			setBusyLabel("Thinking")
			void getAgent().runTurn(value)
		},
		[settings, busy, handleCommand, enqueueMessage, getAgent, pushRow],
	)

	// Resolve the project-hook trust prompt: enable hooks for this workspace (and
	// the live agent) on approval, then run any prompt we deferred while asking.
	const resolveHookTrust = useCallback(
		(trust: boolean) => {
			setPendingHookTrust(null)
			if (trust) {
				trustProjectHooks(process.cwd())
				const updated = loadSettings()
				setSettings(updated)
				agentRef.current?.setHooks(updated.hooks)
				pushRow({ kind: "info", text: "Project hooks trusted — enabled for this workspace." })
			} else {
				pushRow({
					kind: "info",
					text: "Project hooks left disabled. Review .orbcode/settings.json and restart to re-decide.",
				})
			}
			const deferred = deferredPromptRef.current
			deferredPromptRef.current = null
			if (deferred) handleSubmit(deferred)
		},
		[handleSubmit, pushRow],
	)

	// Apply --resume and an initial prompt (`orbcode "do something"`) on startup.
	const bootedRef = useRef(false)
	useEffect(() => {
		if (bootedRef.current) return
		bootedRef.current = true
		if (initialSession) handleResume(initialSession)
		// If this project ships untrusted hooks, ask before running anything; the
		// startup prompt waits until the user decides.
		const pending = getPendingProjectHooks(process.cwd())
		if (pending) {
			setPendingHookTrust(pending)
			deferredPromptRef.current = initialPrompt ?? null
		} else if (initialPrompt) {
			handleSubmit(initialPrompt)
		}
		refreshUsage()
	}, [initialSession, initialPrompt, handleResume, handleSubmit, refreshUsage])

	// Resolve the npm version check after first paint so the TUI shows up
	// immediately and the upgrade banner fades in once we know the answer.
	useEffect(() => {
		if (!updateCheck) return
		let cancelled = false
		updateCheck.then((info) => {
			if (!cancelled) setUpdateInfo(info)
		})
		return () => {
			cancelled = true
		}
	}, [updateCheck])

	useInput((input, key) => {
		// Ctrl+D quits from any view (chat, login, busy, picker, approval,
		// followup). InputBox swallows other Ctrl-combos, but this hook is a
		// sibling of InputBox's hook, so it still sees the key.
		if (key.ctrl && input === "d") {
			endAndExit("prompt_input_exit")
			return
		}
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
			setUsage({ plan: profile.plan, usagePercentage: profile.usagePercentage, tieredUsage: profile.tieredUsage })
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
		view === "chat" &&
		!pendingApproval &&
		!pendingFollowup &&
		!pendingHookTrust &&
		!modelPickerOpen &&
		!resumableSessions

	return (
		<Box flexDirection="column">
			<Static key={staticKey} items={rows}>
				{(row) => <RowView key={row.id} row={row} />}
			</Static>

			{view === "login" ? (
				<LoginSection onLogin={handleLogin} />
			) : (
				<Box flexDirection="column">
					{updateInfo?.updateAvailable && updateInfo.latest && (
						<Box
							marginTop={1}
							flexDirection="column"
							borderStyle="round"
							borderColor={COLORS.warning}
							paddingX={2}
							alignSelf="flex-start"
						>
							<Text color={COLORS.warning} bold>
								↑ Update available: v{updateInfo.current} → v{updateInfo.latest}
							</Text>
							<Text>
								Run <Text color={COLORS.accent}>orbcode update</Text> to install the latest version, then relaunch.
							</Text>
						</Box>
					)}
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
					{pendingHookTrust && (
						<Box marginTop={1}>
							<HookTrustPrompt
								cwd={process.cwd()}
								commands={pendingHookTrust.commands}
								onDecision={resolveHookTrust}
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
					{busy && !pendingApproval && !pendingFollowup && !pendingHookTrust && !streamingText && (
						<Box marginTop={1}>
							<Spinner label={busyLabel} />
						</Box>
					)}
					<Box marginTop={1} flexDirection="column">
						{queuedMessages.length > 0 && (
							<Box flexDirection="column" paddingLeft={1} marginBottom={1}>
								<Text dimColor bold>
									Queue ({queuedMessages.length})
								</Text>
								{queuedMessages.slice(0, 5).map((msg, i) => (
									<Text key={i} dimColor>
										{i + 1}. {truncateForQueue(msg).replace(/\n/g, "↵")}
									</Text>
								))}
								{queuedMessages.length > 5 && (
									<Text dimColor> … {queuedMessages.length - 5} more</Text>
								)}
							</Box>
						)}
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
							tieredUsage={usage?.tieredUsage}
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

const QUEUE_PREVIEW_LIMIT = 80
function truncateForQueue(text: string): string {
	if (text.length <= QUEUE_PREVIEW_LIMIT) return text
	return text.slice(0, QUEUE_PREVIEW_LIMIT - 1) + "…"
}

function LoginSection({ onLogin }: { onLogin: (token: string, profile: ProfileData) => void }) {
	return <LoginView onLogin={onLogin} />
}
