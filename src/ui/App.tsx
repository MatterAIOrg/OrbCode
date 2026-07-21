import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTerminalDimensions } from "@opentui/react";
import { Box, Text, useApp, useInput } from "./primitives.js";
import {
  useTheme,
  useThemeMode,
  type OrbCodeThemeMode,
} from "./theme.js";
import open from "open";
import * as path from "node:path";

import { type SubmittedPrompt, attachmentSummary } from "../attachments.js";
import {
  COLORS,
  ORBITAL_MARK,
  PRODUCT_NAME,
  TAGLINE,
  VERSION,
} from "../branding.js";
import {
  BUILTIN_AXON_MODELS,
  canUse400kContext,
  get200kAxonFallback,
  getModel,
  is400kAxonModel,
  isValidAxonModel,
} from "../api/models.js";
import { LoginView } from "./LoginView.js";
import {
  APP_URL,
  fetchProfile,
  fetchTaskTitle,
  resetWeeklyUsage,
  type ProfileData,
} from "../auth/auth.js";
import {
  getAuthToken,
  getPendingProjectHooks,
  loadSettings,
  saveMcpApproval,
  saveSettings,
  trustProjectHooks,
  type OrbCodeSettings,
} from "../config/settings.js";
import { Agent } from "../core/agent.js";
import { McpManager } from "../mcp/manager.js";
import type { UpdateInfo } from "../utils/updateCheck.js";
import type {
  AgentEvent,
  ApprovalDecision,
  ApprovalRequest,
  FollowupSuggestion,
} from "../core/events.js";
import { Spinner } from "./components/Spinner.js";
import { InputBox, type SlashCommand } from "./components/InputBox.js";
import { ApprovalPrompt } from "./components/ApprovalPrompt.js";
import { FollowupPrompt } from "./components/FollowupPrompt.js";
import { HookTrustPrompt } from "./components/HookTrustPrompt.js";
import { McpApprovalPrompt } from "./components/McpApprovalPrompt.js";
import { McpPicker } from "./components/McpPicker.js";
import { McpMigrationPicker } from "./components/McpMigrationPicker.js";
import {
  applyMigration,
  listMigrationEntries,
  type MigrationEntry,
} from "../commands/migrate.js";
import {
  buildCreateSkillPrompt,
  CREATE_SKILL_USAGE,
} from "../commands/createSkill.js";
import { StatusBar, type ApprovalMode } from "./components/StatusBar.js";
import { ModelPicker } from "./components/ModelPicker.js";
import { ThemePicker } from "./components/ThemePicker.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { listSessions, type SessionData } from "../core/sessions.js";
import {
  diffViewHeight,
  formatToolName,
  formatUserBlock,
  RowView,
  type Row,
} from "./components/rows.js";
import { LinkManager } from "./components/LinkManager.js";
import { PluginManager } from "./components/PluginManager.js";
import {
  getTranscriptPlacement,
  TranscriptViewport,
} from "./components/TranscriptViewport.js";
import {
  addLink,
  loadLinks,
  removeLink,
  resolveProjectDir,
  type LinkedRepo,
} from "../config/links.js";

const SLASH_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "show available commands" },
  { name: "/attach", description: "choose files to attach" },
  { name: "/model", description: "select the Axon model to use" },
  { name: "/theme", description: "choose the OrbCode dark or light theme" },
  {
    name: "/clear",
    description: "clear the screen — the conversation continues",
  },
  { name: "/new", description: "start a new conversation with a clean slate" },
  { name: "/resume", description: "resume a previous session" },
  {
    name: "/compact",
    description: "summarize the conversation to free up context",
  },
  { name: "/tasks", description: "show the current task list" },
  {
    name: "/task",
    description: "reference a previous task in the current conversation",
  },
  {
    name: "/status",
    description: "show session status (model, context, cost, account)",
  },
  { name: "/usage", description: "fetch plan usage" },
  {
    name: "/weekly-reset",
    description: "reset weekly usage (Pro+, once per month)",
  },
  {
    name: "/init",
    description: "analyze this codebase and create an AGENTS.md",
  },
  {
    name: "/create-skill",
    description: "create a repo-local skill from a plain-language description",
  },
  {
    name: "/link",
    description: "link other repos so changes here are checked against them",
  },
  {
    name: "/plugins",
    description: "manage plugins from the official marketplace",
  },
  {
    name: "/mcp",
    description: "manage MCP servers — enable, disable, reconnect, view status",
  },
  {
    name: "/migrate",
    description: "import MCP servers from Claude Code / Claude Desktop",
  },
  {
    name: "/commit",
    description: "check pending changes and create detailed commits",
  },
  {
    name: "/code-review",
    description:
      "expert review of pending changes: performance, security, bugs, tests",
  },
  { name: "/analytics", description: "open your MatterAI analytics dashboard" },
  { name: "/login", description: "sign in to MatterAI" },
  { name: "/logout", description: "sign out and remove the saved token" },
  { name: "/version", description: "show the OrbCode CLI version" },
  { name: "/exit", description: "quit OrbCode CLI" },
];

const WHEEL_SCROLL_LINES = 3;
const SCROLL_FRAME_MS = 32;
const SCROLL_MAX_PENDING_LINES = 24;
const EXIT_CONFIRM_TIMEOUT_MS = 3000;
const INTRO_TOP_MARGIN = 2;

function setTerminalTitle(title: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\x1b]0;${title}\x07`);
  }
}

function formatRelativeTime(isoStr?: string): string {
  if (!isoStr) return "???";
  const now = Date.now();
  const target = new Date(isoStr).getTime();
  if (Number.isNaN(target)) return "???";
  const diff = target - now;
  if (diff <= 0) return "now";
  const sec = Math.floor(diff / 1000);
  const min = Math.floor(sec / 60);
  const hrs = Math.floor(min / 60);
  const days = Math.floor(hrs / 24);
  if (days >= 1) return `in ${days} day${days > 1 ? "s" : ""}`;
  if (hrs >= 1) return `in ${hrs}h ${min % 60}m`;
  if (min >= 1) return `in ${min}m`;
  return "soon";
}

/** Human lines for the /status and /usage usage block (extension profile data). */
function usageLines(profile: ProfileData): string[] {
  const lines: string[] = [];
  if (profile.plan) lines.push(`Plan        ${profile.plan?.toUpperCase()}`);
  if (profile.tieredUsage) {
    const ws: [
      string,
      string,
      import("../auth/auth.js").AxonCodeWindowUsage,
    ][] = [
      ["wk", "Weekly", profile.tieredUsage.weekly],
      ["mo", "Monthly", profile.tieredUsage.monthly],
    ];
    for (const [short, label, w] of ws) {
      const pct = Math.max(0, Math.min(100, w.percentage || 0));
      const reset = formatRelativeTime(w.resetsAt);
      lines.push(`${label.padEnd(12)}${pct}% used · Resets ${reset}`);
    }
  } else if (profile.creditsResetDate) {
    lines.push(`Resets      ${profile.creditsResetDate}`);
  }
  return lines;
}

function buildInitPrompt(agentsPath: string): string {
  return `Analyze this codebase and write a concise AGENTS.md that reduces cold-start for future coding sessions. Create or update the file at exactly this path:

  ${agentsPath}

Investigate first — read the directory layout, key config files, and a few representative source files — then write. Keep it under ~150 lines so it stays cheap to include in every future prompt. Cover, briefly:
1. What the project does (1-2 lines) and its main tech stack.
2. Project structure — the key directories/files and what each is responsible for.
3. Architecture — how the main pieces fit together (entry points, data/control flow).
4. Business-logic / domain mapping — where the core domain concepts live in the code.
5. Notable code patterns and conventions to follow (imports, naming, error handling, tests).
6. The common build, run, lint and test commands.

Favor durable facts over volatile detail. If an AGENTS.md already exists at that path, refine it rather than rewriting from scratch.`;
}

// Ported from the Orbital extension's commit slash command (commitCommandResponse).
const buildCommitPrompt = (
  userInput: string,
) => `The user has explicitly asked you to check pending changes and generate detailed commit messages. You MUST now help them with this.

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

Before committing, present the commit messages to the user for review and ask them to confirm before executing.${userInput ? `\n\nThe user provided the following input with the commit command:\n${userInput}` : ""}`;

const buildCodeReviewPrompt = (
  userInput: string,
) => `The user has explicitly asked you to perform a thorough code review of the pending changes. You MUST now help them with this.

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

This is a review only — do NOT modify any files. Present the findings to the user.${userInput ? `\n\nThe user provided the following input with the code-review command:\n${userInput}` : ""}`;

const MAX_TASK_CONVERSATION_CHARS = 8000;

function extractConversation(session: SessionData): string {
  const lines: string[] = [];
  for (const message of session.messages) {
    if (message.role === "user" && typeof message.content === "string") {
      const match = /<user_query>\n?([\s\S]*?)\n?<\/user_query>/.exec(
        message.content,
      );
      if (match) lines.push(`User: ${match[1]}`);
    } else if (
      message.role === "assistant" &&
      typeof message.content === "string" &&
      message.content.trim()
    ) {
      lines.push(`Assistant: ${message.content}`);
    }
  }
  return lines.join("\n\n");
}

function buildTaskReferencePrompt(session: SessionData): string {
  const conversation = extractConversation(session);
  const truncated =
    conversation.length > MAX_TASK_CONVERSATION_CHARS
      ? conversation.slice(0, MAX_TASK_CONVERSATION_CHARS) +
        "\n\n[... conversation truncated ...]"
      : conversation;
  return `The user has referenced a previous task. Here is the conversation from that task:

<previous_task title="${session.title || session.id}">
${truncated}
</previous_task>

Please summarize this previous task and add it as a reference for the current task. The summary should capture:
- What the task was about
- What was accomplished
- Key decisions made
- Files that were created or modified
- Any remaining work

Present the summary in a clear, organized format. This summary will serve as context for the current task.`;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

interface PendingFollowup {
  question: string;
  suggestions: FollowupSuggestion[];
  resolve: (answer: string) => void;
}

let rowCounter = 0;
function rowId(): string {
  return `row-${rowCounter++}`;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

export function App({
  initialView,
  initialAction,
  initialPrompt,
  initialSession,
  systemPromptOverride,
  updateCheck,
}: {
  initialView?: "login" | "chat";
  initialAction?: "resume";
  initialPrompt?: string;
  initialSession?: SessionData;
  /** Optional override replacing the default system prompt (from `-s`). */
  systemPromptOverride?: string;
  /** Promise resolving to the latest-npm-version comparison; resolved after first paint. */
  updateCheck?: Promise<UpdateInfo>;
}) {
  const { exit } = useApp();
  const theme = useTheme();
  const { mode: themeMode, setMode: setThemeMode } = useThemeMode();
  const { width: termCols, height: termRows } = useTerminalDimensions();
  const [settings, setSettings] = useState<OrbCodeSettings>(() =>
    loadSettings(),
  );
  const [view, setView] = useState<"login" | "chat">(
    initialView ?? (getAuthToken(settings) ? "chat" : "login"),
  );
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

  const [rows, setRows] = useState<Row[]>(() => [
    {
      kind: "header",
      id: "header",
      cwd: process.cwd(),
      modelName: getModel(loadSettings().model).name,
    },
  ]);
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState("Thinking");
  const [exitConfirmationActive, setExitConfirmationActive] = useState(false);
  const [streamingReasoning, setStreamingReasoning] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [inputBoxHeight, setInputBoxHeight] = useState(3);
  const [scrollOffset, setScrollOffset] = useState(0);
  const smoothScrollPendingRef = useRef(0);
  const smoothScrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const [pendingApproval, setPendingApproval] =
    useState<PendingApproval | null>(null);
  const [pendingFollowup, setPendingFollowup] =
    useState<PendingFollowup | null>(null);
  // Set when the current project defines hooks that haven't been trusted yet;
  // gates input until the user decides (project hooks run shell commands).
  const [pendingHookTrust, setPendingHookTrust] = useState<{
    commands: string[];
  } | null>(null);
  // FIFO queue of messages the user typed while the LLM was still streaming.
  // Drained one-per-turn on each `turn-end` event so multi-step work can
  // keep flowing without making the user wait for the previous response.
  const [queuedMessages, setQueuedMessages] = useState<SubmittedPrompt[]>([]);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [resumableSessions, setResumableSessions] = useState<
    SessionData[] | null
  >(null);
  const [taskPickerSessions, setTaskPickerSessions] = useState<
    SessionData[] | null
  >(null);
  const [linkManagerOpen, setLinkManagerOpen] = useState(false);
  const [skillManagerOpen, setSkillManagerOpen] = useState(false);
  const [links, setLinks] = useState<LinkedRepo[]>([]);
  const [linkStatus, setLinkStatus] = useState("");
  // MCP manager (created once, shared across agents in this process). Null until
  // the first agent is created so we don't spawn servers before login.
  const mcpManagerRef = useRef<McpManager | null>(null);
  const [mcpPickerOpen, setMcpPickerOpen] = useState(false);
  // Set when /migrate is open. Holds the entries to show in the picker; null
  // means the picker isn't open. We cache the entries on first open so the
  // picker shows a stable list even if the user cancels and reopens.
  const [mcpMigrationEntries, setMcpMigrationEntries] = useState<
    MigrationEntry[] | null
  >(null);
  // Project-scope MCP servers awaiting the user's approval at startup.
  const [pendingMcpApproval, setPendingMcpApproval] = useState<string[] | null>(
    null,
  );
  const [tasks, setTasks] = useState("");
  const [contextTokens, setContextTokens] = useState(0);
  const [totalCost, setTotalCost] = useState(0);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(() =>
    settings.autoApproveEdits && settings.autoApproveSafeCommands
      ? "auto"
      : settings.autoApproveEdits
        ? "edits"
        : "ask",
  );

  const [sessionTitle, setSessionTitle] = useState("");
  const [usage, setUsage] = useState<{
    plan?: string;
    usagePercentage?: number;
    tieredUsage?: import("../auth/auth.js").AxonCodeTieredUsage;
  } | null>(null);
  const activePlan = usage?.plan ?? usage?.tieredUsage?.plan;
  const has400kAccess = canUse400kContext(activePlan);

  // Refresh plan/usage from /axoncode/profile (shown below the chat box).
  const refreshUsage = useCallback(() => {
    const token = getAuthToken(loadSettings());
    if (!token) return;
    fetchProfile(token)
      .then((profile) =>
        setUsage({
          plan: profile.plan,
          usagePercentage: profile.usagePercentage,
          tieredUsage: profile.tieredUsage,
        }),
      )
      .catch(() => {});
  }, []);

  const agentRef = useRef<Agent | null>(null);
  const expandReasoningRef = useRef(false);
  const reasoningBufferRef = useRef("");
  const textBufferRef = useRef("");
  // taskId for which a title fetch has already been started (once per task).
  const titleTaskRef = useRef<string | null>(null);
  // Mirror of `queuedMessages` for the agent event handler (kept on a ref so
  // we can drain it inside `handleEvent` without re-creating that callback
  // on every keystroke).
  const queueRef = useRef<SubmittedPrompt[]>([]);
  // Holds the startup prompt while we wait for a project-hook trust decision.
  const deferredPromptRef = useRef<string | null>(null);
  // Guards endAndExit against double-invocation (Ctrl+D spam).
  const exitingRef = useRef(false);
  const exitConfirmationRef = useRef(false);
  const exitConfirmationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Mirror of the `-s` override so a fresh agent (created mid-session via
  // /new or /resume) keeps the override instead of falling back to default.
  const systemPromptOverrideRef = useRef<string | undefined>(
    systemPromptOverride,
  );

  const enqueueMessage = useCallback((prompt: SubmittedPrompt) => {
    queueRef.current = [...queueRef.current, prompt];
    setQueuedMessages(queueRef.current);
  }, []);

  const drainQueue = useCallback((): SubmittedPrompt | null => {
    if (queueRef.current.length === 0) return null;
    const [next, ...rest] = queueRef.current;
    queueRef.current = rest;
    setQueuedMessages(rest);
    return next;
  }, []);

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedMessages([]);
  }, []);

  const scrollTranscriptBy = useCallback((lines: number) => {
    setScrollOffset((current) => Math.max(0, current + lines));
  }, []);

  const flushWheelScroll = useCallback(() => {
    const pending = smoothScrollPendingRef.current;
    smoothScrollPendingRef.current = 0;
    if (pending !== 0) scrollTranscriptBy(pending);

    // Coalesce wheel events to one state/layout update per rendered frame.
    smoothScrollTimerRef.current = setTimeout(() => {
      smoothScrollTimerRef.current = null;
      if (smoothScrollPendingRef.current !== 0) flushWheelScroll();
    }, SCROLL_FRAME_MS);
  }, [scrollTranscriptBy]);

  const queueSmoothScroll = useCallback(
    (lines: number) => {
      const pending = smoothScrollPendingRef.current;
      // A direction reversal should respond immediately instead of first
      // draining momentum left over from the previous gesture.
      const next =
        pending !== 0 && Math.sign(pending) !== Math.sign(lines)
          ? lines
          : pending + lines;
      smoothScrollPendingRef.current = Math.max(
        -SCROLL_MAX_PENDING_LINES,
        Math.min(SCROLL_MAX_PENDING_LINES, next),
      );
      if (smoothScrollTimerRef.current === null) {
        flushWheelScroll();
      }
    },
    [flushWheelScroll],
  );

  useEffect(
    () => () => {
      if (smoothScrollTimerRef.current !== null) {
        clearTimeout(smoothScrollTimerRef.current);
      }
      if (exitConfirmationTimerRef.current !== null) {
        clearTimeout(exitConfirmationTimerRef.current);
      }
    },
    [],
  );

  const maybeFetchTitle = useCallback(() => {
    const agent = agentRef.current;
    if (!agent || titleTaskRef.current === agent.taskId) return;
    titleTaskRef.current = agent.taskId;
    const token = getAuthToken(loadSettings());
    if (!token) return;
    void fetchTaskTitle(agent.taskId, token).then((title) => {
      if (title && agentRef.current?.taskId === agent.taskId) {
        setSessionTitle(title);
        setTerminalTitle(title);
        agent.setTitle(title);
      }
    });
  }, []);

  const pushRow = useCallback((row: DistributiveOmit<Row, "id">) => {
    setRows((prev) => [...prev, { ...row, id: rowId() } as Row]);
  }, []);

  // Wipe the visible transcript — a clean slate for /clear, /new and /resume.
  // No manual screen clear is needed because the root always renders one
  // complete terminal-height frame.
  const resetTranscript = useCallback(() => {
    smoothScrollPendingRef.current = 0;
    setScrollOffset(0);
    setRows([
      {
        kind: "header",
        id: rowId(),
        cwd: process.cwd(),
        modelName: getModel(loadSettings().model).name,
      },
    ]);
  }, []);

  const handleEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "reasoning-delta":
          reasoningBufferRef.current += event.text;
          setStreamingReasoning(reasoningBufferRef.current);
          setBusyLabel("Thinking");
          break;
        case "reasoning-done":
          pushRow({
            kind: "reasoning",
            text: reasoningBufferRef.current,
            durationMs: event.durationMs,
            expanded: expandReasoningRef.current,
          });
          reasoningBufferRef.current = "";
          setStreamingReasoning("");
          setBusyLabel("Working");
          break;
        case "text-delta":
          textBufferRef.current += event.text;
          setStreamingText(textBufferRef.current);
          setBusyLabel("Responding");
          break;
        case "text-done":
          pushRow({ kind: "assistant", text: textBufferRef.current });
          textBufferRef.current = "";
          setStreamingText("");
          setBusyLabel("Working");
          break;
        case "stream-reset":
          // An auto-retry is re-streaming this step from scratch — drop the
          // partial text/reasoning shown for the failed attempt so it doesn't
          // duplicate. (Committed rows are untouched; the agent only resets when
          // nothing has been committed yet.)
          textBufferRef.current = "";
          setStreamingText("");
          reasoningBufferRef.current = "";
          setStreamingReasoning("");
          setBusyLabel("Working");
          break;
        case "tool-start":
          setBusyLabel("Working");
          break;
        case "tool-end":
          setBusyLabel("Working");
          pushRow({
            kind: "tool",
            name: event.name,
            summary: event.summary,
            resultPreview: event.resultPreview,
            isError: event.isError,
            diff: event.diff,
          });
          break;
        case "todos":
          setTasks(event.todos);
          break;
        case "usage":
          setContextTokens(event.inputTokens + event.outputTokens);
          setTotalCost(event.totalCost);
          // A usage chunk arrives once per LLM response, so the plan/usage
          // shown below the chat box stays current mid-turn, not only
          // after the turn finishes.
          refreshUsage();
          break;
        case "completion":
          pushRow({ kind: "completion", text: event.result });
          break;
        case "system":
          pushRow({
            kind: event.isError ? "error" : "info",
            text: event.message,
          });
          break;
        case "error":
          pushRow({ kind: "error", text: event.message });
          break;
        case "turn-end":
          // Flush anything still streaming (e.g. on interrupt).
          if (textBufferRef.current) {
            pushRow({ kind: "assistant", text: textBufferRef.current });
            textBufferRef.current = "";
            setStreamingText("");
          }
          if (reasoningBufferRef.current) {
            reasoningBufferRef.current = "";
            setStreamingReasoning("");
          }
          setBusy(false);
          maybeFetchTitle();
          refreshUsage();
          // Pop the next queued message and immediately start a new
          // turn on top of the one that just ended. The agent's
          // `runTurn` is fully resolved at this point (its
          // `finally` emitted this event), so the new turn picks
          // up the up-to-date conversation history. We use
          // `agentRef` directly here to avoid a circular
          // `handleEvent` ↔ `getAgent` reference; the ref is
          // guaranteed populated because `runTurn` set it
          // synchronously before emitting this event.
          const nextQueued = drainQueue();
          if (nextQueued !== null && agentRef.current) {
            pushRow({
              kind: "user",
              text: nextQueued.text,
              attachments: nextQueued.attachments.map(attachmentSummary),
            });
            setBusy(true);
            setBusyLabel("Thinking");
            void agentRef.current.runTurn(
              nextQueued.text,
              nextQueued.attachments,
            );
          }
          break;
      }
    },
    [pushRow, maybeFetchTitle, refreshUsage, drainQueue],
  );

  const createAgent = useCallback(
    (resume?: SessionData): Agent => {
      const current = loadSettings();
      // Create the MCP manager once per process and reuse it across agents
      // (so /new and /resume keep the same server connections). It reads
      // the enabled/disabled lists from settings and connects to approved
      // servers lazily on start().
      if (!mcpManagerRef.current) {
        mcpManagerRef.current = new McpManager(
          process.cwd(),
          current.disabledMcpServers ?? [],
          current.enabledMcpServers ?? [],
        );
      }
      return new Agent({
        cwd: process.cwd(),
        token: getAuthToken(current)!,
        modelId: current.model,
        organizationId: current.organizationId,
        baseUrl: current.baseUrl,
        autoApproveEdits: current.autoApproveEdits,
        autoApproveSafeCommands: current.autoApproveSafeCommands,
        hooks: current.hooks,
        mcp: mcpManagerRef.current,
        resume,
        // The override (from `-s`) is captured in a ref so a /new or /resume
        // mid-session still applies it to the new agent.
        systemPromptOverride: systemPromptOverrideRef.current,
        callbacks: {
          onEvent: handleEvent,
          requestApproval: (request) =>
            new Promise<ApprovalDecision>((resolve) =>
              setPendingApproval({ request, resolve }),
            ),
          requestFollowup: (question, suggestions) =>
            new Promise<string>((resolve) =>
              setPendingFollowup({ question, suggestions, resolve }),
            ),
        },
      });
    },
    [handleEvent],
  );

  const getAgent = useCallback((): Agent => {
    if (!agentRef.current) {
      agentRef.current = createAgent();
      process.env.ORBCODE_LAST_SESSION_ID = agentRef.current.taskId;
    }
    return agentRef.current;
  }, [createAgent]);

  const handleResume = useCallback(
    (session: SessionData) => {
      setResumableSessions(null);
      const resumedAgent = createAgent(session);
      agentRef.current = resumedAgent;
      process.env.ORBCODE_LAST_SESSION_ID = resumedAgent.taskId;
      resetTranscript();
      setTasks(session.todos ?? "");
      setTotalCost(session.totalCost ?? 0);
      // Repopulate the status bar immediately. Without this the context
      // number only appears once the next streaming `usage` chunk arrives,
      // which can be after several seconds of "ctx 0".
      setContextTokens(session.contextTokens ?? 0);
      if (session.title) {
        // The stored title is already the backend one (or the prompt
        // fallback); don't re-fetch for this task.
        titleTaskRef.current = session.id;
        setSessionTitle(session.title);
        setTerminalTitle(session.title);
      }
      // Replay the exact display transcript when available. Agent also builds
      // a best-effort tool/result history for sessions from the legacy schema.
      for (const entry of resumedAgent.displayTranscript) {
        if (entry.kind === "reasoning") {
          pushRow({
            ...entry,
            expanded: expandReasoningRef.current,
          });
        } else {
          pushRow(entry);
        }
      }
      pushRow({
        kind: "info",
        text: `Resumed session: ${session.title || session.id}`,
      });
    },
    [createAgent, pushRow, resetTranscript],
  );

  const handleTaskSelect = useCallback(
    (session: SessionData) => {
      setTaskPickerSessions(null);
      pushRow({
        kind: "user",
        text: `/task (referencing: ${session.title || session.id})`,
      });
      setBusy(true);
      setBusyLabel("Thinking");
      void getAgent().runTurn(buildTaskReferencePrompt(session));
    },
    [getAgent, pushRow],
  );

  const switchModel = useCallback(
    (modelId: string) => {
      if (is400kAxonModel(modelId) && !has400kAccess) {
        pushRow({
          kind: "error",
          text: "400k context is only available on Pro Plus and Ultra plans.",
        });
        return;
      }
      const updated = { ...loadSettings(), model: modelId };
      setSettings(updated);
      saveSettings(updated);
      agentRef.current?.setModel(modelId);
      pushRow({
        kind: "info",
        text: `Model switched to ${getModel(modelId).name}`,
      });
    },
    [has400kAccess, pushRow],
  );

  useEffect(() => {
    if (!activePlan || has400kAccess || !is400kAxonModel(settings.model)) {
      return;
    }

    switchModel(get200kAxonFallback(settings.model));
  }, [activePlan, has400kAccess, settings.model, switchModel]);

  const switchTheme = useCallback(
    (mode: OrbCodeThemeMode) => {
      const updated = { ...settings, theme: mode };
      setSettings(updated);
      saveSettings(updated);
      setThemeMode(mode);
      pushRow({
        kind: "info",
        text: `Theme switched to ${mode}.`,
      });
    },
    [pushRow, setThemeMode, settings],
  );

  // Fire SessionEnd hooks (best-effort, capped at 3s) before quitting.
  const endAndExit = useCallback(
    (reason: string) => {
      const agent = agentRef.current;
      if (!agent) {
        // No agent yet, but the MCP manager may have started; tear it down.
        void mcpManagerRef.current?.stop().catch(() => {});
        exit();
        return;
      }
      // Guard against double-invocation (e.g. the user spamming Ctrl+D):
      // the first call schedules the shutdown; subsequent calls are no-ops.
      if (exitingRef.current) return;
      exitingRef.current = true;
      // Clear the cap timer when SessionEnd finishes first — Promise.race
      // leaves the loser pending, and a ref'd setTimeout would otherwise
      // keep the event loop alive (delaying the actual exit by up to 3s).
      let capTimer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<void>((resolve) => {
        capTimer = setTimeout(resolve, 3000);
        capTimer.unref?.();
      });
      void Promise.race([agent.endSession(reason), cap]).finally(() => {
        if (capTimer) clearTimeout(capTimer);
        agent.abort();
        exit();
      });
    },
    [exit],
  );

  const handleCommand = useCallback(
    (command: string) => {
      const [name, ...rest] = command.split(/\s+/);
      const arg = rest.join(" ");
      switch (name) {
        case "/help":
          pushRow({
            kind: "info",
            text: SLASH_COMMANDS.map(
              (c) => `${c.name.padEnd(12)} ${c.description}`,
            ).join("\n"),
          });
          break;
        case "/model": {
          // The interactive picker is restricted to Axon's own models for now.
          // Third-party providers (Anthropic, OpenAI-compatible) are still
          // usable headlessly via `orbcode -p "..." --model <id>` — see
          // the README "Other providers" section.
          const pickerIds = Object.keys(BUILTIN_AXON_MODELS);
          if (arg && pickerIds.includes(arg)) {
            switchModel(arg);
          } else if (arg && isValidAxonModel(arg)) {
            // Recognized id, but it's a third-party model: not selectable in the TUI.
            pushRow({
              kind: "info",
              text: `Model "${arg}" is only available in non-interactive mode. Run: orbcode -p "..." --model ${arg}`,
            });
          } else if (arg) {
            // Allow short suffixes like "pro" or "mini" to resolve to a
            // matching registered id, preferring the default 200k context.
            const matches = pickerIds
              .filter(
                (id) => id.endsWith(`-${arg}`) || id.includes(`-${arg}-`),
              )
              .sort((a, b) => {
                const aIs200k = a.endsWith("-200k");
                const bIs200k = b.endsWith("-200k");
                if (aIs200k !== bIs200k) return aIs200k ? -1 : 1;
                return b.localeCompare(a);
              });
            if (matches.length > 0) {
              switchModel(matches[0]);
            } else {
              pushRow({
                kind: "error",
                text: `Unknown model "${arg}". Available: ${pickerIds.join(", ")}`,
              });
            }
          } else {
            setModelPickerOpen(true);
          }
          break;
        }
        case "/theme": {
          const requested = arg.trim().toLowerCase();
          if (!requested) {
            setThemePickerOpen(true);
          } else if (requested === "dark" || requested === "light") {
            switchTheme(requested);
          } else {
            pushRow({
              kind: "error",
              text: `Unknown theme "${arg}". Available: dark, light`,
            });
          }
          break;
        }
        case "/clear":
          // Like the terminal's `clear`: wipe the view only. The
          // conversation, session and context all continue.
          resetTranscript();
          break;
        case "/new":
          // Drop the agent entirely so the next message starts a fresh session.
          clearQueue();
          agentRef.current = null;
          titleTaskRef.current = null;
          setSessionTitle("");
          setTerminalTitle("orbcode");
          setTasks("");
          setContextTokens(0);
          resetTranscript();
          break;
        case "/analytics": {
          const url = `${APP_URL}/orbital`;
          pushRow({ kind: "info", text: `Opening analytics: ${url}` });
          void open(url).catch(() => {});
          break;
        }
        case "/resume": {
          const sessions = listSessions(process.cwd()).filter(
            (s) => s.id !== agentRef.current?.taskId,
          );
          if (sessions.length === 0) {
            pushRow({
              kind: "info",
              text: "No previous sessions found for this directory.",
            });
            break;
          }
          setResumableSessions(sessions);
          break;
        }
        case "/task": {
          if (!getAuthToken(settings)) {
            setView("login");
            break;
          }
          const taskSessions = listSessions(process.cwd()).filter(
            (s) => s.id !== agentRef.current?.taskId,
          );
          if (taskSessions.length === 0) {
            pushRow({
              kind: "info",
              text: "No previous tasks found for this directory.",
            });
            break;
          }
          setTaskPickerSessions(taskSessions);
          break;
        }
        case "/compact":
          if (!getAuthToken(settings)) {
            setView("login");
            break;
          }
          setBusy(true);
          setBusyLabel("Compacting");
          void getAgent().compact();
          break;
        case "/tasks":
          pushRow({
            kind: "info",
            text: tasks.trim() ? `Tasks\n${tasks}` : "No tasks yet.",
          });
          break;
        case "/status": {
          const model = getModel(settings.model);
          const contextPct = Math.min(
            100,
            Math.round((contextTokens / model.contextWindow) * 100),
          );
          pushRow({
            kind: "info",
            text: [
              `Version     ${VERSION}`,
              `Model       ${model.name} (${model.id})`,
              `Theme       ${settings.theme[0].toUpperCase()}${settings.theme.slice(1)}`,
              `Directory   ${process.cwd()}`,
              `Account     ${getAuthToken(settings) ? (settings.apiKey || process.env.MATTERAI_TOKEN ? "API key" : "signed in") : "signed out"}${settings.organizationId ? ` · org ${settings.organizationId}` : ""}`,
              `Gateway     ${settings.baseUrl ?? "MatterAI (default)"}`,
              `Context     ${contextTokens.toLocaleString()} / ${model.contextWindow.toLocaleString()} tokens (${contextPct}%)`,
              `Cost        $${totalCost.toFixed(4)} this session`,
              `Approvals   edits ${settings.autoApproveEdits ? "auto" : "ask"} · safe commands ${settings.autoApproveSafeCommands ? "auto" : "ask"}`,
              ...(sessionTitle ? [`Task        ${sessionTitle}`] : []),
            ].join("\n"),
          });
          const statusToken = getAuthToken(settings);
          if (statusToken) {
            fetchProfile(statusToken)
              .then((profile) => {
                const lines = usageLines(profile);
                if (lines.length > 0)
                  pushRow({ kind: "info", text: lines.join("\n") });
              })
              .catch(() => {});
          }
          break;
        }
        case "/init": {
          if (!getAuthToken(settings)) {
            setView("login");
            break;
          }
          pushRow({ kind: "user", text: "/init" });
          setBusy(true);
          setBusyLabel("Thinking");
          const agentsPath = path.join(
            resolveProjectDir(process.cwd()),
            "AGENTS.md",
          );
          void getAgent().runTurn(buildInitPrompt(agentsPath));
          break;
        }
        case "/create-skill": {
          const skillRequest = arg.trim();
          if (!skillRequest) {
            pushRow({ kind: "error", text: CREATE_SKILL_USAGE });
            break;
          }
          if (!getAuthToken(settings)) {
            setView("login");
            break;
          }
          pushRow({ kind: "user", text: command });
          setBusy(true);
          setBusyLabel("Creating skill");
          void getAgent().runTurn(buildCreateSkillPrompt(skillRequest));
          break;
        }
        case "/link":
          setLinks(loadLinks(process.cwd()));
          setLinkStatus("");
          setLinkManagerOpen(true);
          break;
        case "/plugin":
        case "/plugins":
        case "/skills": // legacy alias
          setSkillManagerOpen(true);
          break;
        case "/mcp": {
          const manager = mcpManagerRef.current;
          if (!manager) {
            pushRow({
              kind: "info",
              text: "MCP not initialized yet — send a message first.",
            });
            break;
          }
          setMcpPickerOpen(true);
          break;
        }
        case "/migrate": {
          // Scan for sources now (cheap — just file reads) and cache the list
          // so the picker has a stable view. `applyMigration` re-reads the
          // destination on confirm, so a stale snapshot is fine.
          setMcpMigrationEntries(listMigrationEntries());
          break;
        }
        case "/commit":
          if (!getAuthToken(settings)) {
            setView("login");
            break;
          }
          pushRow({ kind: "user", text: command });
          setBusy(true);
          setBusyLabel("Thinking");
          void getAgent().runTurn(buildCommitPrompt(arg));
          break;
        case "/code-review":
          if (!getAuthToken(settings)) {
            setView("login");
            break;
          }
          pushRow({ kind: "user", text: command });
          setBusy(true);
          setBusyLabel("Reviewing");
          void getAgent().runTurn(buildCodeReviewPrompt(arg));
          break;
        case "/version":
          pushRow({ kind: "info", text: `OrbCode CLI v${VERSION}` });
          break;
        case "/usage": {
          pushRow({ kind: "info", text: "Fetching plan usage…" });
          const token = getAuthToken(settings);
          if (token) {
            fetchProfile(token)
              .then((profile) => {
                const lines = usageLines(profile);
                if (lines.length > 0)
                  pushRow({ kind: "info", text: lines.join("\n") });
              })
              .catch(() => {});
          }
          break;
        }
        case "/weekly-reset": {
          const token = getAuthToken(settings);
          if (!token) {
            setView("login");
            break;
          }
          pushRow({ kind: "info", text: "Resetting weekly usage…" });
          resetWeeklyUsage(token)
            .then((result) => {
              setUsage((current) => ({
                ...current,
                plan: result.tieredUsage.plan,
                tieredUsage: result.tieredUsage,
              }));
              pushRow({
                kind: "info",
                text: `Weekly usage reset. Available again ${formatRelativeTime(result.weeklyReset.nextAvailableAt ?? undefined)}.`,
              });
            })
            .catch((error) => {
              pushRow({
                kind: "error",
                text:
                  error instanceof Error
                    ? error.message
                    : "Failed to reset weekly usage.",
              });
            });
          break;
        }
        case "/login":
          setView("login");
          break;
        case "/logout": {
          clearQueue();
          void agentRef.current?.endSession("logout");
          setPendingHookTrust(null);
          deferredPromptRef.current = null;
          const updated = { ...settings, token: undefined };
          setSettings(updated);
          saveSettings(updated);
          agentRef.current = null;
          setView("login");
          break;
        }
        case "/exit":
          endAndExit("prompt_input_exit");
          break;
        default:
          pushRow({
            kind: "error",
            text: `Unknown command: ${name}. Try /help.`,
          });
      }
    },
    [
      settings,
      tasks,
      contextTokens,
      totalCost,
      sessionTitle,
      endAndExit,
      pushRow,
      getAgent,
      switchModel,
      switchTheme,
      resetTranscript,
      clearQueue,
    ],
  );

  const handleSubmit = useCallback(
    (input: string | SubmittedPrompt) => {
      const prompt =
        typeof input === "string" ? { text: input, attachments: [] } : input;
      const { text, attachments } = prompt;
      smoothScrollPendingRef.current = 0;
      setScrollOffset(0);
      if (text.startsWith("/")) {
        if (attachments.length > 0) {
          pushRow({
            kind: "info",
            text: "Attachments are ignored for slash commands.",
          });
        }
        handleCommand(text);
        return;
      }
      if (!getAuthToken(settings)) {
        setView("login");
        return;
      }
      // While the LLM is still streaming, hold the message in a FIFO
      // queue instead of dropping it on the floor. `handleEvent`'s
      // `turn-end` case drains the queue and starts the next turn.
      if (busy) {
        enqueueMessage(prompt);
        return;
      }
      pushRow({
        kind: "user",
        text,
        attachments: attachments.map(attachmentSummary),
      });
      setBusy(true);
      setBusyLabel("Thinking");
      void getAgent().runTurn(text, attachments);
    },
    [settings, busy, handleCommand, enqueueMessage, getAgent, pushRow],
  );

  // Resolve the project-hook trust prompt: enable hooks for this workspace (and
  // the live agent) on approval, then run any prompt we deferred while asking.
  const resolveHookTrust = useCallback(
    (trust: boolean) => {
      setPendingHookTrust(null);
      if (trust) {
        trustProjectHooks(process.cwd());
        const updated = loadSettings();
        setSettings(updated);
        agentRef.current?.setHooks(updated.hooks);
        pushRow({
          kind: "info",
          text: "Project hooks trusted — enabled for this workspace.",
        });
      } else {
        pushRow({
          kind: "info",
          text: "Project hooks left disabled. Review .orbcode/settings.json and restart to re-decide.",
        });
      }
      const deferred = deferredPromptRef.current;
      deferredPromptRef.current = null;
      if (deferred) handleSubmit(deferred);
    },
    [handleSubmit, pushRow],
  );

  // Resolve the MCP server approval prompt: connect to the approved project
  // servers, persist the decision, and proceed with any deferred startup prompt.
  const resolveMcpApproval = useCallback(
    async (approved: string[]) => {
      setPendingMcpApproval(null);
      const manager = mcpManagerRef.current;
      if (manager) {
        // Enable each approved server (connects immediately). Disapproved
        // ones stay disabled and won't prompt again (persisted below).
        await Promise.all(
          approved.map((name) => manager.enableServer(name).catch(() => {})),
        );
        saveMcpApproval(
          process.cwd(),
          manager.getEnabled(),
          manager.getDisabled(),
        );
        const snap = manager.snapshot();
        const connected = snap.servers.filter(
          (s) => s.status === "connected",
        ).length;
        pushRow({
          kind: "info",
          text: `MCP: ${connected}/${snap.servers.length} server${snap.servers.length === 1 ? "" : "s"} connected${approved.length ? ` (approved: ${approved.join(", ")})` : ""}.`,
        });
      }
      const deferred = deferredPromptRef.current;
      deferredPromptRef.current = null;
      if (deferred) handleSubmit(deferred);
    },
    [handleSubmit, pushRow],
  );

  // Tear down the live MCP manager (if any), then create a fresh one from
  // the current on-disk settings and start it. Used after /migrate (new
  // servers added) and after a /mcp delete (server removed) so /mcp works
  // immediately without needing to send a message first. The agent is also
  // dropped so the next message rebuilds it against the new manager's tool
  // list.
  const rebuildMcpManager = useCallback(async () => {
    const oldManager = mcpManagerRef.current;
    mcpManagerRef.current = null;
    if (oldManager) {
      await oldManager.stop().catch(() => {});
    }
    agentRef.current = null;
    const refreshed = loadSettings();
    setSettings(refreshed);
    if (getAuthToken(refreshed)) {
      const manager = new McpManager(
        process.cwd(),
        refreshed.disabledMcpServers ?? [],
        refreshed.enabledMcpServers ?? [],
      );
      mcpManagerRef.current = manager;
      void manager.start().then(() => {
        const pendingMcp = manager.getPendingApproval();
        if (pendingMcp.length > 0) setPendingMcpApproval(pendingMcp);
      });
    }
  }, []);

  // Apply a user-confirmed migration selection: write the chosen entries to
  // ~/.orbcode/settings.json, then rebuild the MCP manager so the new
  // user-scope servers connect immediately. Skips (name conflicts)
  // are reported but not fatal.
  const resolveMcpMigration = useCallback(
    async (selected: MigrationEntry[]) => {
      if (selected.length === 0) {
        pushRow({
          kind: "info",
          text: "MCP migration cancelled (no servers selected).",
        });
        return;
      }
      const result = applyMigration(selected);
      const addedNames = result.added.map((e) => e.name);
      const skippedCount = result.skipped.length;
      if (result.added.length === 0) {
        pushRow({
          kind: "info",
          text: `MCP migration: nothing added (${skippedCount} skipped — name${skippedCount === 1 ? "" : "s"} already in use).`,
        });
        return;
      }
      pushRow({
        kind: "info",
        text: `MCP migration: added ${result.added.length} server${result.added.length === 1 ? "" : "s"} to ~/.orbcode/settings.json (${addedNames.join(", ")})${skippedCount > 0 ? `; skipped ${skippedCount} (name already in use).` : "."}`,
      });
      // Tear down the live manager + agent, then immediately rebuild the
      // manager so /mcp works without needing to send a message first.
      // The agent is dropped so the next message creates a fresh one that
      // picks up the new manager's tool list.
      await rebuildMcpManager();
    },
    [pushRow, rebuildMcpManager],
  );

  // Handle a permanent delete from the /mcp picker. The manager has already
  // dropped the server from its in-memory state and from the on-disk config;
  // we persist the cleaned enabled/disabled lists, rebuild the manager so
  // /mcp reflects the deletion immediately, and surface a one-line
  // confirmation.
  const handleMcpServerDeleted = useCallback(
    async (name: string) => {
      const manager = mcpManagerRef.current;
      if (manager) {
        // `removeServer` already removed the name from both lists, but
        // `saveMcpApproval` needs the post-removal snapshot so the
        // per-project settings don't keep a dangling reference.
        saveMcpApproval(
          process.cwd(),
          manager.getEnabled(),
          manager.getDisabled(),
        );
      }
      pushRow({
        kind: "info",
        text: `MCP: removed "${name}" from the config. Use \`orbcode mcp add ${name} …\` to re-add it.`,
      });
      // Rebuild the manager from the now-trimmed on-disk config so /mcp
      // works immediately and the next message gets a fresh agent with the
      // correct tool list.
      await rebuildMcpManager();
    },
    [pushRow, rebuildMcpManager],
  );

  // Apply --resume and an initial prompt (`orbcode "do something"`) on startup.
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (initialSession) handleResume(initialSession);
    if (initialAction === "resume") handleCommand("/resume");
    // If this project ships untrusted hooks, ask before running anything; the
    // startup prompt waits until the user decides.
    const pending = getPendingProjectHooks(process.cwd());
    if (pending) {
      setPendingHookTrust(pending);
      deferredPromptRef.current = initialPrompt ?? null;
    } else if (initialPrompt) {
      handleSubmit(initialPrompt);
    }
    // Start the MCP manager and surface any project-scope servers that need
    // approval. The approval prompt is non-blocking: the agent can start
    // working while the user decides, and approved servers connect live.
    const current = loadSettings();
    if (getAuthToken(current)) {
      const manager = new McpManager(
        process.cwd(),
        current.disabledMcpServers ?? [],
        current.enabledMcpServers ?? [],
      );
      mcpManagerRef.current = manager;
      void manager.start().then(() => {
        const pendingMcp = manager.getPendingApproval();
        if (pendingMcp.length > 0) setPendingMcpApproval(pendingMcp);
      });
    }
    refreshUsage();
  }, [
    initialSession,
    initialAction,
    initialPrompt,
    handleResume,
    handleCommand,
    handleSubmit,
    refreshUsage,
  ]);

  // Resolve the npm version check after first paint so the TUI shows up
  // immediately and the upgrade banner fades in once we know the answer.
  useEffect(() => {
    if (!updateCheck) return;
    let cancelled = false;
    updateCheck.then((info) => {
      if (!cancelled) setUpdateInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [updateCheck]);

  useInput((input, key) => {
    if (view === "chat" && key.pageUp) {
      smoothScrollPendingRef.current = 0;
      scrollTranscriptBy(Math.max(1, contentHeight - 2));
      return;
    }
    if (view === "chat" && key.pageDown) {
      smoothScrollPendingRef.current = 0;
      scrollTranscriptBy(-Math.max(1, contentHeight - 2));
      return;
    }
    // Require two presses so an accidental Ctrl+D cannot discard the session.
    // The ref makes rapid repeated presses reliable before React re-renders.
    if (key.ctrl && input === "d") {
      if (exitConfirmationRef.current) {
        exitConfirmationRef.current = false;
        setExitConfirmationActive(false);
        if (exitConfirmationTimerRef.current !== null) {
          clearTimeout(exitConfirmationTimerRef.current);
          exitConfirmationTimerRef.current = null;
        }
        endAndExit("prompt_input_exit");
      } else {
        exitConfirmationRef.current = true;
        setExitConfirmationActive(true);
        exitConfirmationTimerRef.current = setTimeout(() => {
          exitConfirmationRef.current = false;
          exitConfirmationTimerRef.current = null;
          setExitConfirmationActive(false);
        }, EXIT_CONFIRM_TIMEOUT_MS);
        exitConfirmationTimerRef.current.unref?.();
      }
      return;
    }
    if (key.escape && busy && !pendingApproval && !pendingFollowup) {
      agentRef.current?.abort();
    }
    if (key.tab && key.shift) {
      setApprovalMode((prev) => {
        const next: ApprovalMode =
          prev === "ask" ? "edits" : prev === "edits" ? "auto" : "ask";
        const autoApproveEdits = next !== "ask";
        const autoApproveSafeCommands = next === "auto";
        const updated = {
          ...loadSettings(),
          autoApproveEdits,
          autoApproveSafeCommands,
        };
        setSettings(updated);
        saveSettings(updated);
        agentRef.current?.setApprovalMode(
          autoApproveEdits,
          autoApproveSafeCommands,
        );
        return next;
      });
    }
    if (key.ctrl && input === "o") {
      const expanded = !expandReasoningRef.current;
      expandReasoningRef.current = expanded;
      // Re-render the whole transcript (including past thinking) with the
      // new expansion state.
      setRows((prev) =>
        prev.map((row) =>
          row.kind === "reasoning" ? { ...row, expanded } : row,
        ),
      );
      // The terminal adapter replaces the retained screen rows in place.
    }
  });

  const handleLogin = useCallback(
    (token: string, profile: ProfileData) => {
      const updated = { ...loadSettings(), token };
      setSettings(updated);
      saveSettings(updated);
      agentRef.current = null;
      setView("chat");
      setUsage({
        plan: profile.plan,
        usagePercentage: profile.usagePercentage,
        tieredUsage: profile.tieredUsage,
      });
      const who = profile.user?.name || profile.user?.email;
      pushRow({
        kind: "info",
        text: `Signed in${who ? ` as ${who}` : ""}. Ready when you are.`,
      });
    },
    [pushRow],
  );

  const taskLines = useMemo(
    () =>
      tasks
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    [tasks],
  );

  const inputActive =
    view === "chat" &&
    !pendingApproval &&
    !pendingFollowup &&
    !pendingHookTrust &&
    !pendingMcpApproval &&
    !modelPickerOpen &&
    !themePickerOpen &&
    !mcpPickerOpen &&
    !mcpMigrationEntries &&
    !resumableSessions &&
    !taskPickerSessions &&
    !linkManagerOpen &&
    !skillManagerOpen;

  const popoverOpen =
    !!pendingFollowup ||
    modelPickerOpen ||
    themePickerOpen ||
    mcpPickerOpen ||
    !!mcpMigrationEntries ||
    !!resumableSessions ||
    !!taskPickerSessions ||
    linkManagerOpen ||
    skillManagerOpen;

  // ── Viewport management ─────────────────────────────────────────────
  // Instead of <Static> (which permanently writes to stdout and causes
  // uncontrolled scrolling), we render everything in the dynamic region and
  // only show the rows that fit above the pinned input box + status bar.
  // This keeps the input box always at the bottom of the terminal.

  // This is only used for scroll-range/page-size calculations. Layout itself
  // is handled by flexbox below: the transcript shrinks while this bottom
  // region never does, which is what actually pins the prompt to the bottom.
  const hasUsageLine = Boolean(
    usage?.tieredUsage?.weekly || usage?.tieredUsage?.monthly,
  );
  // InputBox reports its real height because multiline input and autocomplete
  // popups make the bottom stack taller than the normal three-row prompt.
  // StatusBar is one row, plus its optional usage row.
  let bottomControlsHeight = inputBoxHeight + 1 + (hasUsageLine ? 1 : 0);
  if (queuedMessages.length > 0) {
    bottomControlsHeight +=
      2 +
      Math.min(5, queuedMessages.length) +
      (queuedMessages.length > 5 ? 1 : 0);
  }

  const contentHeight = Math.max(1, termRows - bottomControlsHeight);
  const wrapWidth = Math.max(20, termCols - 4);
  const approvalMaxDiffLines = Math.max(
    1,
    Math.min(60, contentHeight - 6),
  );

  const rowLayout = useMemo(() => {
    let top = 0;
    const items = rows.map((row) => {
      const height = Math.max(1, estimateRowLines(row, wrapWidth));
      const item = { row, top, bottom: top + height };
      top += height;
      return item;
    });
    return { items, height: top };
  }, [rows, wrapWidth]);
  const rowsHeight = rowLayout.height;

  let dynamicHeight = 0;
  if (updateInfo?.updateAvailable && updateInfo.latest) dynamicHeight += 6;
  const reasoningWrapWidth = Math.max(20, wrapWidth - 2);
  const streamingReasoningDisplay = streamingReasoning
    ? tailForHeight(streamingReasoning, 3, reasoningWrapWidth)
    : "";
  // Do not lay out the entire accumulated response on every token. Keep only
  // the live tail mounted; text-done commits the complete response to the
  // virtualized transcript, so nothing is lost from history.
  const streamingTextDisplay = streamingText
    ? tailForHeight(
        streamingText,
        Math.max(1, contentHeight - 1),
        Math.max(20, wrapWidth - 2),
      )
    : "";
  if (streamingReasoning) {
    dynamicHeight +=
      2 + wrapHeight(streamingReasoningDisplay, reasoningWrapWidth);
  }
  if (streamingTextDisplay) {
    dynamicHeight += 1 + wrapHeight(`● ${streamingTextDisplay}`, wrapWidth);
  }
  if (taskLines.length > 0) {
    const taskWidth = Math.max(20, wrapWidth - 1);
    dynamicHeight +=
      2 +
      taskLines
        .slice(0, 10)
        .reduce((height, line) => height + wrapHeight(line, taskWidth), 0) +
      (taskLines.length > 10 ? 1 : 0);
  }
  if (pendingApproval) {
    const approval = pendingApproval.request;
    const nestedWidth = Math.max(1, wrapWidth - 2);
    const question =
      approval.kind === "command" && approval.isDangerous
        ? "Run this command? (marked as potentially dangerous)"
        : approval.kind === "command"
          ? "Run this command?"
          : "Apply this change?";
    const choices = `(y) yes · (n) no${approval.isDangerous ? "" : " · (a) always for this session"}`;
    dynamicHeight +=
      1 +
      wrapHeight(`◆ ${formatToolName(approval.toolName)} ${approval.summary}`, wrapWidth) +
      wrapHeight(question, nestedWidth) +
      (approval.diff
        ? diffViewHeight(approval.diff, approvalMaxDiffLines)
        : wrapHeight(approval.detail, nestedWidth)) +
      wrapHeight(choices, nestedWidth);
  }
  if (pendingHookTrust) {
    dynamicHeight += 6 + Math.min(8, pendingHookTrust.commands.length);
  }
  if (pendingMcpApproval) {
    dynamicHeight += 5 + Math.min(8, pendingMcpApproval.length);
  }
  if (
    busy &&
    !pendingApproval &&
    !pendingFollowup &&
    !pendingHookTrust &&
    !pendingMcpApproval &&
    !mcpPickerOpen &&
    !mcpMigrationEntries &&
    !streamingText &&
    !streamingReasoning
  ) {
    dynamicHeight += 2;
  }

  const transcriptHeight = Math.max(1, rowsHeight + dynamicHeight);
  const maxScrollOffset = Math.max(0, transcriptHeight - contentHeight);
  const effectiveScrollOffset = Math.min(scrollOffset, maxScrollOffset);
  const introHeaderOnly = rows.length === 1 && rows[0]?.kind === "header";
  const transcriptPlacement = getTranscriptPlacement({
    contentHeight,
    introHeaderOnly,
    introTopMargin: INTRO_TOP_MARGIN,
    scrollOffset: effectiveScrollOffset,
    transcriptHeight,
  });

  const viewportTop =
    !introHeaderOnly && transcriptHeight > contentHeight
      ? maxScrollOffset - effectiveScrollOffset
      : 0;
  const virtualRows = useMemo(() => {
    const items = rowLayout.items;
    if (items.length === 0) {
      return { rows: [] as Row[], startY: 0, endY: 0 };
    }
    if (introHeaderOnly || transcriptHeight <= contentHeight) {
      return {
        rows: items.map((item) => item.row),
        startY: 0,
        endY: rowsHeight,
      };
    }

    // Keep a full viewport mounted on either side. The overscan hides small
    // differences between estimated wrapped heights and Yoga's final layout.
    const from = Math.max(0, viewportTop - contentHeight);
    const to = Math.min(rowsHeight, viewportTop + contentHeight * 2);

    let low = 0;
    let high = items.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (items[mid]!.bottom <= from) low = mid + 1;
      else high = mid;
    }
    const start = low;

    low = start;
    high = items.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (items[mid]!.top < to) low = mid + 1;
      else high = mid;
    }
    const end = low;
    const startY = items[start]?.top ?? rowsHeight;
    const endY = end > start ? items[end - 1]!.bottom : startY;

    return {
      rows: items.slice(start, end).map((item) => item.row),
      startY,
      endY,
    };
  }, [
    contentHeight,
    introHeaderOnly,
    rowLayout,
    rowsHeight,
    transcriptHeight,
    viewportTop,
  ]);
  const virtualTranscriptMarginTop =
    transcriptPlacement.marginTop + virtualRows.startY;
  const rowBottomSpacerHeight = Math.max(0, rowsHeight - virtualRows.endY);
  // Height estimates are only an approximation of OpenTUI's word wrapping.
  // At the live edge, let Yoga align the rendered content itself so the last
  // line always remains above the composer even when an earlier row wrapped to
  // more lines than estimated. Estimates still drive virtualization/scrolling.
  const anchorTranscriptToBottom = transcriptPlacement.anchorToBottom;

  useEffect(() => {
    setScrollOffset((current) => Math.min(current, maxScrollOffset));
  }, [maxScrollOffset]);

  // OpenTUI owns an alternate-screen surface. The root and every overlay use
  // native filled boxes, so their backgrounds are real terminal cells rather
  // than ANSI spans behind only the text glyphs.
  return (
    <Box
      flexDirection="column"
      width={termCols}
      height={termRows}
      paddingX={2}
      overflow="hidden"
      position="relative"
      backgroundColor={theme.background}
      shouldFill
      onMouseScroll={(event) => {
        if (view !== "chat" || !event.scroll) return;
        const direction = event.scroll.direction;
        if (direction !== "up" && direction !== "down") return;
        const sign = direction === "up" ? 1 : -1;
        queueSmoothScroll(sign * Math.max(1, event.scroll.delta) * WHEEL_SCROLL_LINES);
        event.preventDefault();
      }}
    >
      {view === "login" ? (
        <LoginSection onLogin={handleLogin} />
      ) : (
        <Box
          flexDirection="column"
          flexGrow={1}
          minHeight={0}
          overflow="hidden"
        >
          <TranscriptViewport anchorToBottom={anchorTranscriptToBottom}>
            <Box
              flexDirection="column"
              flexShrink={0}
              marginTop={
                anchorTranscriptToBottom ? 0 : virtualTranscriptMarginTop
              }
            >
              {virtualRows.rows.map((row) => (
                <RowView key={row.id} row={row} width={wrapWidth} />
              ))}
              {rowBottomSpacerHeight > 0 && (
                <Box height={rowBottomSpacerHeight} flexShrink={0} />
              )}
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
                    ↑ Update available: v{updateInfo.current} → v
                    {updateInfo.latest}
                  </Text>
                  <Text>
                    Run <Text color={COLORS.accent}>orbcode update</Text> to
                    install the latest version, then relaunch.
                  </Text>
                </Box>
              )}
              {streamingReasoning && (
                <Box flexDirection="column" marginTop={1}>
                  <Spinner label="Thinking" showTip />
                  <Box paddingLeft={2}>
                    <Text color={COLORS.dim} italic>
                      {streamingReasoningDisplay}
                    </Text>
                  </Box>
                </Box>
              )}
              {streamingTextDisplay && (
                <Box marginTop={1}>
                  <Text>
                    <Text color={COLORS.primary}>● </Text>
                    {streamingTextDisplay}
                  </Text>
                </Box>
              )}
              {taskLines.length > 0 && (
                <Box flexDirection="column" marginTop={1} paddingLeft={1}>
                  <Text color={COLORS.dim} bold>
                    Tasks
                  </Text>
                  {taskLines.slice(0, 10).map((line, i) => (
                    <Text
                      key={i}
                      color={
                        /^[-*]\s*\[x\]/i.test(line)
                          ? COLORS.dim
                          : COLORS.primary
                      }
                    >
                      {line
                        .replace(/^[-*]\s*\[x\]/i, "  ■")
                        .replace(/^[-*]\s*\[-\]/, "  ◧")
                        .replace(/^[-*]\s*\[ \]/, "  □")}
                    </Text>
                  ))}
                  {taskLines.length > 10 && (
                    <Text color={COLORS.dim}>
                      {" "}
                      … {taskLines.length - 10} more
                    </Text>
                  )}
                </Box>
              )}
              {pendingApproval && (
                <ApprovalPrompt
                  request={pendingApproval.request}
                  width={wrapWidth}
                  maxDiffLines={approvalMaxDiffLines}
                  onDecision={(decision) => {
                    pendingApproval.resolve(decision);
                    setPendingApproval(null);
                  }}
                />
              )}
              {pendingHookTrust && (
                <HookTrustPrompt
                  cwd={process.cwd()}
                  commands={pendingHookTrust.commands}
                  onDecision={resolveHookTrust}
                />
              )}
              {pendingMcpApproval && (
                <McpApprovalPrompt
                  serverNames={pendingMcpApproval}
                  onApprove={resolveMcpApproval}
                />
              )}
              {busy &&
                !pendingApproval &&
                !pendingFollowup &&
                !pendingHookTrust &&
                !pendingMcpApproval &&
                !mcpPickerOpen &&
                !mcpMigrationEntries &&
                !streamingText &&
                !streamingReasoning && (
                  <Box marginTop={1}>
                    <Spinner
                      label={busyLabel}
                      showTip={
                        busyLabel === "Thinking" || busyLabel === "Working"
                      }
                    />
                  </Box>
                )}
            </Box>
          </TranscriptViewport>
          <Box flexDirection="column" flexShrink={0}>
            {queuedMessages.length > 0 && (
              <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
                <Text color={COLORS.dim} bold>
                  Queue ({queuedMessages.length})
                </Text>
                {queuedMessages.slice(0, 5).map((msg, i) => (
                  <Text key={i} color={COLORS.dim}>
                    {i + 1}.{" "}
                    {truncateForQueue(msg.text || "Attached files").replace(
                      /\n/g,
                      "↵",
                    )}
                    {msg.attachments.length > 0
                      ? ` · 📎 ${msg.attachments.length}`
                      : ""}
                  </Text>
                ))}
                {queuedMessages.length > 5 && (
                  <Text color={COLORS.dim}>
                    {" "}
                    … {queuedMessages.length - 5} more
                  </Text>
                )}
              </Box>
            )}
            <InputBox
              active={inputActive}
              width={wrapWidth}
              slashCommands={SLASH_COMMANDS}
              onSubmit={handleSubmit}
              supportsImages={getModel(settings.model).supportsImages}
              onHeightChange={setInputBoxHeight}
            />
            <StatusBar
              modelId={settings.model}
              contextTokens={contextTokens}
              totalCost={totalCost}
              state={busy ? busyLabel : ""}
              approvalMode={approvalMode}
              busy={busy}
              exitConfirmationActive={exitConfirmationActive}
              title={sessionTitle}
              plan={usage?.plan}
              usagePercentage={usage?.usagePercentage}
              tieredUsage={usage?.tieredUsage}
            />
          </Box>
        </Box>
      )}
      {popoverOpen && (
        <Box
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height="100%"
          flexDirection="column"
          alignItems="center"
          justifyContent="center"
          zIndex={100}
        >
          <Box
            flexDirection="column"
            width={Math.max(24, Math.min(90, termCols - 8))}
            backgroundColor={theme.panel}
            shouldFill
          >
            {modelPickerOpen && (
              <ModelPicker
                currentId={settings.model}
                canUse400k={has400kAccess}
                onSelect={(modelId) => {
                  setModelPickerOpen(false);
                  switchModel(modelId);
                }}
                onCancel={() => setModelPickerOpen(false)}
              />
            )}
            {themePickerOpen && (
              <ThemePicker
                current={themeMode}
                onSelect={(mode) => {
                  setThemePickerOpen(false);
                  switchTheme(mode);
                }}
                onCancel={() => setThemePickerOpen(false)}
              />
            )}
            {resumableSessions && (
              <SessionPicker
                sessions={resumableSessions}
                onSelect={handleResume}
                onCancel={() => setResumableSessions(null)}
              />
            )}
            {taskPickerSessions && (
              <SessionPicker
                sessions={taskPickerSessions}
                title="Reference a previous task"
                onSelect={handleTaskSelect}
                onCancel={() => setTaskPickerSessions(null)}
              />
            )}
            {linkManagerOpen && (
              <LinkManager
                links={links}
                status={linkStatus}
                onAdd={(input) => {
                  const result = addLink(process.cwd(), input);
                  setLinkStatus(result.message);
                  if (result.ok) setLinks(loadLinks(process.cwd()));
                }}
                onRemove={(link) => {
                  removeLink(process.cwd(), link.path);
                  setLinks(loadLinks(process.cwd()));
                  setLinkStatus(`Unlinked ${path.basename(link.path)}`);
                }}
                onClose={() => setLinkManagerOpen(false)}
              />
            )}
            {skillManagerOpen && (
              <PluginManager onClose={() => setSkillManagerOpen(false)} />
            )}
            {mcpPickerOpen && mcpManagerRef.current && (
              <McpPicker
                manager={mcpManagerRef.current}
                onChanged={() => {
                  const m = mcpManagerRef.current;
                  if (m)
                    saveMcpApproval(
                      process.cwd(),
                      m.getEnabled(),
                      m.getDisabled(),
                    );
                }}
                onCancel={() => setMcpPickerOpen(false)}
                onDeleted={handleMcpServerDeleted}
              />
            )}
            {mcpMigrationEntries && (
              <McpMigrationPicker
                entries={mcpMigrationEntries}
                onCancel={() => setMcpMigrationEntries(null)}
                onConfirm={(selected) => {
                  setMcpMigrationEntries(null);
                  resolveMcpMigration(selected);
                }}
              />
            )}
            {pendingFollowup && (
              <FollowupPrompt
                question={pendingFollowup.question}
                suggestions={pendingFollowup.suggestions}
                onAnswer={(answer) => {
                  pushRow({ kind: "user", text: answer });
                  pendingFollowup.resolve(answer);
                  setPendingFollowup(null);
                }}
              />
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
}

/** Count the number of terminal rows a block of text will occupy (accounting
 * for wrapping at `width` columns). */
function wrapHeight(text: string, width: number): number {
  return text
    .split("\n")
    .reduce(
      (sum, line) =>
        sum + Math.max(1, Math.ceil(Math.max(1, line.length) / width)),
      0,
    );
}

/** Return the tail of `text` that fits within `maxLines` terminal rows,
 * accounting for line wrapping at `width` columns. */
function tailForHeight(text: string, maxLines: number, width: number): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let height = 0;
  for (let i = lines.length - 1; i >= 0 && height < maxLines; i--) {
    const line = lines[i];
    const wrapped = Math.max(1, Math.ceil(Math.max(1, line.length) / width));
    if (height + wrapped > maxLines) {
      const remaining = maxLines - height;
      if (remaining > 0) {
        const chars = remaining * width;
        result.unshift(line.slice(-chars));
      }
      break;
    }
    result.unshift(line);
    height += wrapped;
  }
  return result.join("\n");
}

/** Estimate how many terminal lines a committed row will occupy. Intentionally
 * slightly conservative (overestimates) so we never show too many rows and
 * push the input box off-screen. */
function estimateRowLines(row: Row, width: number): number {
  const w = Math.max(20, width);
  function wrapped(text: string, lineWidth = w): number {
    const available = Math.max(1, lineWidth);
    return text
      .split("\n")
      .reduce(
        (sum, line) =>
          sum + Math.max(1, Math.ceil(Math.max(1, line.length) / available)),
        0,
      );
  }
  switch (row.kind) {
    case "header": {
      const panelWidth = Math.max(20, w - 4);
      const infoWidth = Math.max(10, panelWidth - 17);
      const firstCellWidth = Math.min(30, panelWidth);
      const secondCellWidth = Math.max(10, panelWidth - firstCellWidth - 2);
      const wrappedAt = (text: string, lineWidth: number) =>
        text
          .split("\n")
          .reduce(
            (sum, line) =>
              sum +
              Math.max(1, Math.ceil(Math.max(1, line.length) / lineWidth)),
            0,
          );
      const heroTextHeight =
        wrappedAt(`${PRODUCT_NAME} / v${VERSION}`, infoWidth) +
        wrappedAt(TAGLINE, infoWidth) +
        1 +
        wrappedAt(`MODEL      ${row.modelName}`, infoWidth) +
        wrappedAt(`WORKSPACE  ${row.cwd}`, infoWidth);
      const heroHeight = Math.max(ORBITAL_MARK.length, heroTextHeight);
      const firstActionRow = Math.max(
        wrappedAt("/new      fresh conversation", firstCellWidth),
        wrappedAt("/resume   continue a session", secondCellWidth),
      );
      const secondActionRow = Math.max(
        wrappedAt("/model    switch active model", firstCellWidth),
        wrappedAt("/help     all commands", secondCellWidth),
      );
      const shortcuts = wrappedAt(
        "shift+tab approvals · ctrl+o thinking · esc interrupt · ctrl+d exit",
        panelWidth,
      );
      // Action/footer top margins plus Header's bottom margin add three rows.
      return heroHeight + firstActionRow + secondActionRow + shortcuts + 3;
    }
    case "user":
      return (
        1 + formatUserBlock(row.text, w, row.attachments).split("\n").length
      );
    case "assistant":
      return 1 + wrapped(`● ${row.text}`);
    case "reasoning":
      return row.expanded ? 2 + wrapped(row.text, w - 2) : 2;
    case "tool": {
      const heading = `${formatToolName(row.name)} ${row.summary}`;
      let h = 1 + wrapped(heading);
      if (row.diff) {
        // DiffView adds a stats row and an 8-ish-column number/type gutter.
        // Hunk headers are structural and aren't rendered as their own rows.
        const diffLines = row.diff
          .split("\n")
          .filter((line) => !line.startsWith("@@"));
        const visible = diffLines.slice(0, 60);
        h +=
          1 +
          visible.reduce((height, line) => height + wrapped(line, w - 10), 0) +
          (diffLines.length > 60 ? 1 : 0);
      } else if (row.resultPreview) {
        h += wrapped(row.resultPreview, w - 2);
      }
      return h;
    }
    case "info":
      return 1 + wrapped(row.text);
    case "error":
      return 1 + wrapped(`✗ ${row.text}`);
    case "completion":
      return 4 + wrapped(row.text, w - 4);
    default:
      return 1;
  }
}

const QUEUE_PREVIEW_LIMIT = 80;
function truncateForQueue(text: string): string {
  if (text.length <= QUEUE_PREVIEW_LIMIT) return text;
  return text.slice(0, QUEUE_PREVIEW_LIMIT - 1) + "…";
}

function LoginSection({
  onLogin,
}: {
  onLogin: (token: string, profile: ProfileData) => void;
}) {
  return <LoginView onLogin={onLogin} />;
}
