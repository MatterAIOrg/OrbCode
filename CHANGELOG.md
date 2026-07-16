# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-07-16

### Added

- **Accepted code metrics reporting.** Successful `file_edit`, `file_write`,
  and `multi_file_edit` calls now POST line counters (added/deleted, language)
  to `/axoncode/meta/<taskId>/lines`, matching the extension's behavior. Works
  for both user-approved and auto-approved edits; reporting is best-effort and
  never blocks the session.

## [0.4.8] - 2026-07-15

### Added

- **Plugin marketplace browser (`/plugins`).** A new tabbed UI lists installed
  plugins and browses the complete Anthropic `claude-plugins-official`
  marketplace. Installation downloads the pinned plugin source as one bundle
  into `.orb/plugins/<name>/`, preserving skills, commands, agents, MCP config,
  hooks, scripts, rules, and other supporting files. Search filters by name,
  description, or author. `/plugin` and the former `/skills` command remain as
  aliases.
- **Non-interactive plugin management.** `orbcode plugin install
clickhouse@claude-plugins-official`, `orbcode plugin list`, and `orbcode
plugin uninstall <name>` provide the same install flow outside the TUI.

### Fixed

- **Marketplace installation no longer depends on GitHub tree scans.** The
  previous per-repository `SKILL.md` scan quickly exhausted GitHub's anonymous
  API limit and incorrectly reported that plugins such as ClickHouse had no
  skills. OrbCode now installs `git-subdir`, `url`, `github`, and official
  relative-path sources through git at the marketplace-pinned revision.
- **Plugin components are loaded from the installed bundle.** Skills and legacy
  commands are exposed as `<plugin>:<skill>`, bundled reference files remain
  available, and `.mcp.json`/manifest MCP servers are namespaced and discovered
  as project-scoped servers with `${CLAUDE_PLUGIN_ROOT}` substitution.
- **Standalone project skills use `.orb/skills/`.** The skill loader discovers
  that directory alongside the legacy `.orbcode/skills/` location.

### Changed

- **All popovers are now centered on screen.** Pickers, prompts, and
  managers (model picker, session picker, link manager, plugin manager, MCP
  picker, approval prompts, follow-up prompts, hook trust, MCP approval,
  migration picker) render as an absolutely-positioned overlay centered
  vertically and horizontally instead of flowing inline with the
  transcript.

- **The TUI now preserves the terminal's configured colors.** Startup and
  cleanup no longer emit OSC 10/11 or OSC 110/111 sequences that override or
  reset the terminal's default foreground and background colors.
- **The built-in UI palette follows both light and dark terminal themes.**
  Neutral text inherits the terminal foreground, semantic accents use the
  terminal's named ANSI palette, and prompts and popups no longer apply
  hardcoded background colors. Diff rows retain their original 5% alpha-blended
  backgrounds, with OrbCode green (`#3FA266`) and red (`#E34671`) used
  consistently across themes.
- **The OrbCode company logo is isolated from terminal theming.** Its outer
  cyan (`#06E1E7`), inner cyan (`#8BF4F7`), and white core (`#ffffff`) remain
  identical in every terminal theme.

## [0.4.3] - 2026-07-13

### Changed

- **Diff background colors are now 50% transparent.** Added/removed line
  backgrounds in the diff view are alpha-blended against the terminal
  background (`#1a1a1a`), producing a muted green (`#2C5E40`) and muted red
  (`#7E3045`) that are less visually aggressive while preserving the red/green
  semantic.
- **Viewport layout adapts to the real input box height.** The input box now
  reports its rendered height to the parent viewport (including multiline
  prompt wrapping, slash-command popups, and file-completion popups), so the
  bottom controls stack never overlaps the live response. The previous
  hardcoded 4-row estimation caused overflow on multiline input or when
  autocomplete was open.
- **Streaming output is truncated to the viewport tail.** Instead of
  accumulating the entire streaming response in the live area (which pushed
  the input box off-screen in long generations), only lines fitting the
  available height are rendered. The complete response is committed to the
  transcript on completion.
- **Diff line-height estimates in the virtualized transcript now account for
  the number/type gutter.** The diff gutter occupies ~8 columns, so each
  content line wraps at a narrower width. Hunks headers are structural and
  skipped. This prevents underestimation that could overflow the viewport.
- **Task list height measurement uses proper word-wrap calculations.** Task
  items are now wrapped at the available terminal width instead of counting
  raw lines, so long task descriptions don't push controls off-screen.
- **Reasoning row height estimates account for the gutter.** Collapsed
  reasoning rows are measured at `width - 2` to match the actual render,
  preventing underestimation that clips the fold header.
- **Result preview and completion text use correct line widths.** Both are
  now wrapped at `width - 2` and `width - 4` respectively, matching the
  indentation they render at.

### Fixed

- **Resumed sessions now restore reasoning and tool history.** New sessions
  persist the exact visible transcript, including thinking durations, tool
  summaries, result previews, errors, and diffs. Older sessions reconstruct
  tool calls, results, and edit fragments from their stored model messages
  when possible.
- **@-file autocomplete now shows files created during the session.**
  The file list was computed once on mount (via `useMemo([], [])`), so new
  files created by editing or manually never appeared in the `@` popup.
  Changed to re-scan the workspace each time the `@` popup opens.

## [0.4.2] - 2026-07-13

### Changed

- **Default theme now uses a neutral base with consistent semantic accents.**
  The explicit palette uses `#ffffff` primary, `#d0d0d0` accent,
  `#a8a8a8` thinking, `#7a7a7a` dim, and `#1a1a1a` background, while errors
  and removals use `#E34671`, successes and additions use `#3FA266`, and
  approval warnings use `#E2CE76`. All `<Text dimColor>` usages were replaced
  with explicit `color={COLORS.dim}`. Code blocks follow `COLORS.accent`, and
  edit-tool diff backgrounds now use the shared error/success colors.
- **TUI now runs in the alternate screen buffer as an independent surface.**
  On startup the app enters `\x1b[?1049h` (alternate screen) and sets the
  terminal's default foreground/background via OSC 10/11 to the greyscale
  palette, so every cell — including text without an explicit color prop —
  follows the theme. The terminal scrollback is no longer affected; on
  exit the original screen and colors are restored (`\x1b]110\x07`,
  `\x1b]111\x07`, `\x1b[?1049l`).
- **All content has horizontal margin.** The root container in `App.tsx`
  now carries `marginX={2}` so the header, conversation rows, pickers,
  prompts, input box, and status bar all sit inset from the terminal edge
  consistently. The per-component `marginX` that was previously on the
  input box was removed to avoid double margin.
- **Input box is now a fully-bordered rounded box with quieter chrome.** The
  previous chrome drew only top/bottom rules (`borderLeft/Right={false}`); it
  now draws all four sides with `borderStyle="round"`, using a 50%-brightness
  border so the input remains visually anchored without dominating the chat.
- **The initial OrbCode header is top-anchored with a stable margin.** The
  borderless intro uses a half-size cyan/white ASCII interpretation of the
  `orbital.svg` brand mark alongside a metadata column, followed by a compact
  two-column command grid and shortcut row. Temporary command and picker UI
  grows below it without recentering or shifting the brand surface.
- **User messages render as full-width borderless highlighted blocks.** A
  subtle neutral background spans the transcript width inside the global
  margins with two-cell horizontal and one-row vertical padding,
  distinguishing prompts without adding more terminal chrome.
- **Command and file-completion popups use padded rounded surfaces.** Slash
  commands and `@file` results now share a solid neutral background with
  same-color half-cell corner caps and padded content, without a contrasting
  border.
- **Approval modes have semantic highlighting again.** Ask mode is white,
  edit approval is yellow, and auto-approval is green.

### Fixed

- **Diff add/remove lines now render with explicit foreground color.**
  Previously the added/removed lines in `DiffView` set only
  `backgroundColor`, leaving the text color at the terminal default — on
  some terminals the text was invisible against the dark green/red
  backgrounds. Both now set `color={COLORS.primary}` so the text is
  always readable.
- **Spinner no longer causes the input box to flicker.** The spinner is
  wrapped in `<Box marginTop={1}>` (2 terminal lines), but the viewport
  budget only reserved 1 line for it. This made the spacer over-allocate
  by one line, so every time the spinner's second counter changed width
  the input box shifted up and back down. The middle-height estimate now
  correctly accounts for 2 lines.
- **Fullscreen TUI no longer leaves duplicate frames in the scrollback.**
  The root now always matches the real terminal dimensions, forcing Ink's
  full-redraw path. Full frames are converted from newline-delimited output
  to retained, cursor-addressed row replacements inside a synchronized
  terminal update. Neither linefeeds nor per-frame display clears are emitted,
  so renders cannot advance or archive terminal history. Fullscreen activation
  also follows any interactive stdin/stdout/stderr stream instead of relying
  only on `stdout.isTTY`, which is absent in some terminal wrappers. The TUI
  captures the same complete set of mouse modes as
  OpenTUI (`1000`, `1002`, `1003`, and `1006`), preventing wheel/trackpad
  gestures from scrolling the terminal itself. Only the clipped chat
  transcript handles wheel and page scrolling; login and other non-chat views
  ignore it. The transcript is the sole shrinking region while the input and
  status controls remain fixed at the bottom, including during terminal
  resizes.
- **Scrolling is smoother and fixed controls no longer flicker.** Wheel input
  is coalesced to Ink's render cadence instead of creating a backlog of tiny
  animated steps. Completed transcript rows are memoized, and long histories
  mount only the visible rows plus overscan instead of re-rendering and laying
  out the entire conversation on every wheel event. The terminal adapter also
  keeps a retained row cache and only writes rows whose rendered content
  changed, so spinner/streaming timers do not repaint the input or status area.
- **The thinking animation remains visible during reasoning streams.** The
  first reasoning token no longer replaces the animated activity indicator
  with a static label; the spinner stays mounted above the live preview until
  reasoning completes.
- **Ctrl+D now requires confirmation.** The first press shows a three-second
  `Press Ctrl+D again to exit` warning in the status bar; only a second press
  exits the session. Escape now clears a non-empty chat input, including any
  open slash-command or file-completion state.
- **Live AI output is no longer clipped in resumed or narrow-terminal chats.**
  Transcript virtualization now accounts for every committed row's margins
  and borders, while status-bar fields remain single-line. Streaming text
  therefore retains its reserved viewport rows and paints before completion.

## [0.4.1] - 2026-07-08

### Fixed

- **Input box now stays pinned to the bottom of the terminal.** Removed
  `<Static>` (which permanently wrote rows to stdout and caused the whole
  view to scroll up when a long response completed). Rows are now rendered
  in the dynamic region with viewport-capped visibility — only the rows that
  fit above the input box are shown. A spacer fills the gap when content is
  short so the input box + status bar are always at the bottom. Streaming
  text is capped with `tailForHeight()` (accounting for line wrapping) so it
  never grows tall enough to push the input box off-screen.

## [0.4.0] - 2026-07-05

### Added

- **`/task` slash command to reference a previous task.** `orbcode /task` (or
  `/task` in the TUI) opens a session picker over previous sessions in the same
  directory. On selection, the prior conversation is wrapped in
  `<previous_task>` tags and the model is prompted to summarize it as reference
  for the current task. Conversations longer than ~8000 chars are truncated so
  the prompt stays well under context limits. If no previous tasks exist, a
  friendly info row is shown instead of opening an empty picker.
- **`axon-eido-3-flash`** replaces `axon-code-2-5-mini` as the free model in
  the built-in registry. Flash offers 200K context, fast responses, and zero
  cost — suitable for low-effort day-to-day tasks. `axon-code-2-5-pro` has been
  removed from the built-in catalog (use `customModels` if you still need it).

### Changed

- **System prompt rewritten for speed and editing discipline.** The `always
gather exhaustive context` guidance is replaced with a `gather enough context,
then act` principle. The model is now told that a small, localized change
  typically needs about 3-6 tool calls and that further exploration after the
  edit point is identified is waste. The TODO list rule is tightened to
  multi-step tasks (3+ steps). A new editing discipline block instructs the
  model to copy `old_string` verbatim from a same-turn read, treat earlier reads
  as stale after a successful edit, and never guess at a corrected
  `old_string` when a `multi_file_edit` batch fails. `read_file` and
  `search_files` sections get concise references with reading/search hygiene
  rules. A `Verifying tool results and avoiding loops` section teaches the model
  to check that outputs match the sent parameters and never repeat an identical
  failing call. `Plan before editing` mandates writing the full plan once, then
  executing edits in one batched pass with a single typecheck/build at the end.

### Fixed

- **Transient model stream failures are now automatically retried.** Connection
  drops before the first chunk (DNS/socket reset/TLS, plus 5xx, 408, 429) are
  retried up to 3 times with exponential backoff capped at 8s. Real 4xx client
  errors and user aborts are not retried. A `Connection to the model failed
(...). Retrying n/3 in Ns…` message is emitted so the user sees progress.
  The backoff is interruptible so Ctrl+C never gets stuck.
- **Reasoning phase timing now reflects only the thinking time.** Previously a
  single `hadReasoning` flag caused the `Thought for Ns` timer to span the
  entire reasoning+answer span. Reasoning is now modeled as open/close segments:
  it opens on the first reasoning delta and closes on the first text delta or
  tool call, matching the on-screen `Thinking` block behavior and supporting
  interleaved reasoning/content correctly.
- **Mid-stream retry allowed when partial output can be rolled back.** When a
  connection drops after some output has streamed, the agent can now re-issue
  the request if it can cleanly undo the partial output (reset text buffers,
  clear pending tool calls, emit a `stream-reset` event for the UI). The
  restart is declined if a reasoning row was already committed to the
  transcript. The compaction path also supports mid-stream retry for its
  in-memory summary buffer.

## [0.3.3] - 2026-06-30

### Added

- **Linked repositories (`/link`).** A new `/link` slash command opens an
  interactive manager where you point this repo at other repos on your machine
  (enter a folder path — absolute, `~/path`, or relative to the project). Links
  are persisted per-project in
  `.orb/links.json` and injected into the agent's environment details —
  including each linked repo's `AGENTS.md`, pulled in ahead of time — so a
  change here is checked for impact on, or propagated to, the linked repos.
  `.orb/links.json` is shared with the Orbital IDE extension (links written
  there are honored here, and vice versa), and a linked repo's `AGENTS.md` is
  read from `.orb/`, `.orbital/`, or `.orbcode/`.

### Changed

- **`/init` now writes to `.orb/AGENTS.md` and targets cold-start.** The
  generated `AGENTS.md` is written to the repo-level `.orb/` directory and now
  captures project structure, architecture, business-logic mapping, and code
  patterns/conventions — the context an agent needs to start coding without
  re-exploring. The cap is now ~150 lines (up from ~60) so it can cover all
  four sections without being truncated.
- **Repo-level agent data lives in `.orb/`.** The folder OrbCode creates in a
  project for `AGENTS.md` (and now `links.json`) is `.orb/` — a single,
  tool-neutral name shared by the IDE and the CLI. Machine settings are
  unchanged (`~/.orbcode` and `<repo>/.orbcode/settings.json` stay put); the
  legacy `.orbcode/AGENTS.md` location is still read for backward compatibility.

## [0.3.2] - 2026-06-24

### Fixed

- **MatterAI inference routed to the wrong backend.** `AxonClient` was
  building the OpenAI `baseURL` by running `API_GATEWAY_PATH`
  (`https://api2.matterai.so/v1/web/`) through `getUrlFromToken`, which
  rehosts _any_ `api.matterai.so` target onto the control-plane host
  resolved from the JWT — so every inference request silently hit
  `https://api.matterai.so/v1/web/` instead of the gateway at
  `https://api2.matterai.so/v1/web/`. The gateway URL is now used
  directly, with the per-model `baseUrl` override still winning for
  local dev. Profile, task title, balance, and web search/fetch still
  go through the rehost helper (they intentionally target the control
  plane).

## [0.3.1] - 2026-06-23

### Changed

- **Release workflow run title now shows the version.** The `Release` GitHub
  Actions workflow gained a `run-name` (e.g. `Release v0.3.1`) so manual
  dispatches and tag pushes are easier to tell apart in the Actions list. No
  functional change to the publish flow.

## [0.3.0] - 2026-06-23

### Added

- **MCP server migration from Claude Code / Claude Desktop.** A new
  `orbcode mcp migrate` subcommand (with `--all` and `--dry-run` flags) and
  a `/migrate` slash command in the TUI scan well-known paths for MCP server
  configs and copy them into `~/.orbcode/settings.json` (user scope). Sources
  detected:
  - `~/.claude/settings.json` (Claude Code, user scope)
  - `~/.claude.json` → root `mcpServers` (Claude Code, user scope — the most
    common location, written by `claude mcp add -s user …`)
  - `~/.claude.json` → `projects.<cwd>.mcpServers` (Claude Code, this project)
  - `claude_desktop_config.json` (Claude Desktop — platform-specific path)

  When the same server name appears in both layers of `~/.claude.json`, the
  root entry is shown and the project-layer duplicate is hidden (Claude's
  own per-project override precedence). The TUI shows a combined checklist
  across all sources; the CLI prints a preview by default and only writes
  with `--all`. Servers whose name already exists in the destination are
  silently skipped and counted in the summary. Codex support (TOML) is
  intentionally deferred.

- **Delete action in the `/mcp` picker.** The interactive server manager
  gained a "Delete" action (last in the list, red) that permanently removes
  a server from its config file (whichever scope it lives in) and shows a
  y/n confirmation before doing it. Unlike Disable, Delete is irreversible
  — the config entry is gone, and you'll need to re-add the server with
  `orbcode mcp add` to get it back.
- **Styled OAuth callback page.** The local browser page that receives the
  OAuth redirect now matches the matterai.so look (dark `#0d1117`
  background, centered card, green/red circular icon, brand footer) for
  success, error, and not-found paths, replacing the previous plain
  `<h1>` strings.

## [0.2.4] - 2026-06-22

### Added

- **`-s` / `--system-prompt` flag to override the default system prompt.**
  Pass `orbcode -s "<text>"` (or `--system-prompt "<text>"`, or
  `--system-prompt="<text>"` for values that start with `-`) to replace the
  built-in system prompt entirely for the session. Works in both the
  interactive TUI and headless mode (`-p`); passing `-p "..." -s "..."` runs a
  single non-interactive turn under your custom prompt. When the override is
  active, AGENTS.md memory files and the skills catalog are skipped, since
  they live inside the default prompt — the model receives only your text as
  its system message. Useful for code-review or other specialized personas.
- **"Working" spinner with elapsed timer.** After the model finishes thinking
  (or streaming a response), a `⠋ Working (Xs · esc to interrupt)` spinner now
  appears and stays visible through tool execution and any gap before the next
  LLM response — covering the previously dead-air window where long synchronous
  operations (e.g. writing a large file) showed no feedback at all. The spinner
  is hidden while the "Thinking" or response-streaming indicators are active so
  the two never overlap.

### Changed

- The per-tool running indicator (tool name + summary line) has been removed in
  favour of the single "Working" spinner. Tool results are still shown as rows
  in the transcript once each tool completes.

## [0.2.3] - 2026-06-19

### Fixed

- `orbcode mcp add` no longer swallows a `--` separator after the server
  name as the command. `orbcode mcp add --scope user context7 -- npx -y
@upstash/context7-mcp ...` previously wrote `command: "--"` (a literal
  `--`), so the server failed to spawn. A `--` immediately after the server
  name is now consumed as the flag/command separator, matching Claude Code's
  `claude mcp add <name> -- <command>`. A later `--` is still passed through
  as a literal argument to the server command.

### Changed

- **`/cost` slash command renamed to `/usage`.** It now fetches and prints
  your plan usage from `/axoncode/profile` — the plan name (uppercased) and,
  for tiered accounts, the 5-hour / weekly / monthly windows with percentage
  used and reset time (or the credits reset date for non-tiered accounts) —
  instead of showing the session cost and fetching the account balance.
  Session cost remains in the status bar and `/status`. The usage block no
  longer prints the legacy `usagePercentage` and `remainingReviews` lines.

## [0.2.0] - 2026-06-17

### Changed

- **Breaking: all `ORBCODE_*` environment variables renamed to `MATTERAI_*`.**
  This aligns the CLI's env-var namespace with the MatterAI brand. Update any
  scripts, CI configs, or `.env` files that set these variables. The renamed
  variables are: `ORBCODE_TOKEN` → `MATTERAI_TOKEN`,
  `ORBCODE_API_KEY` → `MATTERAI_API_KEY`, `ORBCODE_BASE_URL` → `MATTERAI_BASE_URL`,
  `ORBCODE_MODEL` → `MATTERAI_MODEL`, `ORBCODE_CONFIG_DIR` → `MATTERAI_CONFIG_DIR`,
  `ORBCODE_BACKEND_URL` → `MATTERAI_BACKEND_URL`, `ORBCODE_APP_URL` → `MATTERAI_APP_URL`,
  `ORBCODE_PROJECT_DIR` → `MATTERAI_PROJECT_DIR`, and
  `ORBCODE_TRUST_PROJECT_HOOKS` → `MATTERAI_TRUST_PROJECT_HOOKS`.

## [0.1.14] - 2026-06-17

### Added

- **Multi-provider support via the Vercel AI SDK.** A `customModels` entry that
  sets a `provider` is now served through the AI SDK instead of the MatterAI
  gateway, reusing the same agent loop, tools, and approvals. Auth is the
  provider's own key (env var or per-model `apiKey`), not the MatterAI login.
  New model fields: `provider`, `baseUrl`, `apiKey`, `effort`, `reasoning`.
  - `provider: "anthropic"` → native `/v1/messages` (`@ai-sdk/anthropic`).
    Adaptive thinking + reasoning streaming are on by default; `effort`
    (`low`…`max`) tunes depth; prompt-caching breakpoints are set on the system
    prompt and conversation prefix automatically. Set `"reasoning": false` to
    disable thinking (e.g. for models that reject `effort`).
  - `provider: "openai-compatible"` → any OpenAI-compatible endpoint; requires
    `baseUrl`. Key from `apiKey` on the entry.
  - Anything without a `provider` (or `provider: "matterai"`/`"axon"`) keeps
    using the MatterAI gateway untouched.
- **Built-in Anthropic Claude models**, served natively via the Anthropic
  provider so `--model claude-…` works without a settings.json entry: Claude
  Opus 4.8, 4.7, 4.6; Sonnet 4.6; Haiku 4.5 (thinking disabled — it rejects
  `effort`); and Fable 5. Auth is `ANTHROPIC_API_KEY` (or a per-model `apiKey`).
- **Axon Eido 3 Mini** model added to the Axon registry.
- Headless mode (`-p`) now warns on stderr when an unknown `--model` /
  `MATTERAI_MODEL` silently resolves to the default, instead of quietly running
  a different model than requested.

### Changed

- The agent now constructs its transport through a `createLLMClient` factory
  backed by an `LLMClient` interface, so `agent.ts` is agnostic to whether a
  model is served by the MatterAI gateway or the AI SDK. Both clients implement
  the same contract; messages and tools stay in the OpenAI shape the rest of
  the app speaks.
- Headless auth gate now only requires a MatterAI login token when the selected
  model actually routes through the MatterAI gateway. AI-SDK providers
  authenticate with their own key, so `orbcode -p` works without `orbcode login`
  when using e.g. an Anthropic model.
- Anthropic thinking blocks are stashed (opaque, with their signatures) on the
  persisted assistant message and replayed verbatim on the next turn, so
  interleaved thinking with tool use round-trips correctly. The field is
  stripped before any OpenAI `/chat/completions` request.

## [0.1.13] - 2026-06-17

### Security

- **Hooks no longer receive OrbCode credentials.** Hook commands now run with a
  redacted environment: `MATTERAI_TOKEN`, `MATTERAI_API_KEY`,
  `MATTERAI_CONFIG_DIR`, `MATTERAI_BACKEND_URL`, `MATTERAI_APP_URL`, and any
  variable whose name matches a credential pattern (`*TOKEN*`, `*KEY*`,
  `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*PRIVATE_KEY*`) is stripped. A
  hook can no longer exfiltrate your API token. Non-credential vars (`PATH`,
  `HOME`, `MATTERAI_PROJECT_DIR`, …) are preserved.
- **`MATTERAI_TRUST_PROJECT_HOOKS=1` is now only honored when stdin is not a
  TTY.** A stray `export` in a shell rc file can no longer silently disable the
  project-hook trust gate for interactive sessions; the escape hatch still
  works in CI/headless mode. Only the exact value `"1"` is honored (not
  `"true"`).
- **Hook-injected context is sandboxed.** `additionalContext` (and plain stdout
  on `UserPromptSubmit`/`SessionStart`) is now wrapped in `<hook_context>` tags
  and capped at ~8 KB. The system prompt instructs the model to treat the
  contents as untrusted, closing a prompt-injection vector.
- **Tool-input rewrites are now logged.** When a `PreToolUse` hook rewrites a
  tool's input via `updatedInput`, OrbCode emits a visible system message so
  you can see that a hook changed what the model asked for.
- **Matcher regexes are auto-anchored.** `"execute_command"` now matches exactly
  that tool name, not `"execute_command_extra"`. Use `"a|b"` for alternation.

### Changed

- Default hook timeout lowered from 60s to **10s** so a slow hook can't block
  the tool hot path for a full minute. Override per-command with `timeout`.
- `Agent.clear()` now resets `pendingStartContext`, `sessionStarted`, and
  `stopHookActive` so a `/new` after a hook-bearing session starts clean.
- SessionStart context is folded into the `/compact` request instead of
  lingering for the next turn.
- `endAndExit` guards against double-invocation (Ctrl+D spam) and unrefs its
  cap timer so it never keeps the event loop alive.
- `/logout` now clears any pending hook-trust prompt and deferred startup
  prompt.
- The HookTrustPrompt now documents that Enter defaults to "keep disabled".
- In-flight `Notification` hooks are tracked and awaited (up to 3s) on
  `endSession`, so a slow notification hook can't leak a child process.
- A `PostToolUse` hook that stops the turn now emits a system message.

### Added

- `test-hook-env.mjs`: verifies credential env vars are redacted from hooks.
- New test cases: matcher auto-anchoring, alternation, SIGKILL escalation,
  context cap, strict `MATTERAI_TRUST_PROJECT_HOOKS` value, PreToolUse
  `ask`/`allow` + `updatedInput` interactions.

## [0.1.12] - 2026-06-16

### Added

- Lifecycle **hooks**, compatible with Claude Code's hooks contract. Configure
  shell commands in the `hooks` block of `settings.json` (user- and
  project-level blocks are merged) to run at well-defined points in the agent
  loop: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`,
  `Notification`, `Stop`, `PreCompact`, and `SessionEnd` (plus `SubagentStop`,
  reserved for future subagents). Hooks receive a JSON payload on stdin and can
  block a tool or prompt, skip/force an approval, rewrite tool input, inject
  context, or stop a turn — via exit codes (0/2/other) or a JSON object on
  stdout. Each hook is sandboxed with a per-command timeout and can never crash
  the agent. Overview in the README's Hooks section; full reference with a
  copy-paste cookbook in [docs/HOOKS.md](docs/HOOKS.md).
- Project-hook **trust gate**: hooks defined in a repo's
  `.orbcode/settings.json` execute shell commands, so they are disabled until
  you approve them in a one-time prompt (your own `~/.orbcode/settings.json`
  hooks always run). Trust is content-hashed — editing a project's hooks
  re-prompts — and persisted to `~/.orbcode/hook-trust.json`. Non-interactive
  (`-p`) runs skip untrusted project hooks with a warning;
  `MATTERAI_TRUST_PROJECT_HOOKS=1` opts in for CI.

## [0.1.8] - 2026-06-12

### Added

- `orbcode update --force` (`-f`): force a global `npm install -g` even when
  the running CLI doesn't look like a global install (e.g. local dev checkout
  pointing at a global prefix). Prints a warning so it's never silent.

### Fixed

- `orbcode update` now correctly detects global installs on systems where the
  CLI entrypoint is a symlink. `isGlobalInstall` resolves symlinks via
  `realpathSync` (with `import.meta.url` as a fallback) before matching the
  `node_modules/@matterailab/orbcode` path, so a perfectly valid
  `npm i -g` install no longer reports "not installed globally".
- Suppressed the `node-domexception@1.0.0 deprecated` warning on install
  by overriding `formdata-node` to `^6.0.3` (the version pulled in via
  `openai@4.104.0 → formdata-node@4.4.1` was the last remaining user of
  that polyfill; `formdata-node@6` has zero runtime dependencies).

## [0.1.5] - 2026-06-12

### Added

- `orbcode update` CLI subcommand: self-updates the globally installed package
  from npm, with helpful messaging for local/dev installs.
- Message queueing — you can now type and send messages while the LLM is still
  streaming; they are queued and drained one-per-turn on each `turn-end` event.
- Update notifications in the TUI header: if a newer npm version is available, a
  prominent banner shows `↑ Update available: vX.Y.Z → vA.B.C`.
- `Shift+Enter` inserts a literal newline in the input box without submitting.
- `Ctrl+D` quits from any view (chat, login, busy, approval, followup).

### Changed

- Paste behaviour: multi-char pastes with trailing newlines no longer
  auto-submit; newlines inside pasted text are inserted literally.
- Input box remains active while the LLM is busy, enabling the new message
  queueing feature.
- README now includes a product screenshot (`assets/orbcode-screenshot.webp`).

### Fixed

- `/new` and `/logout` now properly clear the message queue to prevent stale
  submissions.

## [0.1.4] - 2026-06-12

The first public release of `orbcode` on npm as `@matterailab/orbcode`. A
terminal port of the Orbital extension: an interactive TUI agent driven by
Axon models by MatterAI, with streaming chat, live thinking, tool activity,
edit/command approvals, todo tracking, session persistence, and headless
non-interactive mode.

### Added

- Interactive TUI built on Ink 5 + React 18, with full-screen takeover,
  streaming markdown responses, and a status bar showing model, context
  usage, and session cost.
- Live `✦ Thinking…` display for reasoning deltas (`reasoning`,
  `reasoning_content`, and inline ` ``` ` blocks), collapsible via
  `Ctrl+O`.
- Tool rows with formatted names, one-line summaries, live "running" state,
  and result previews; editing tools render real line-numbered diffs
  (red/green) in both the approval prompt and the finished row.
- Edit/command approval flow: read-only tools run silently; mutating tools
  prompt first with `y` / `n` / `a` (allow for the session). A model-side
  `isDangerous` flag prevents auto-approval of destructive commands under
  any mode, including `--yolo`.
- Slash commands: `/help`, `/model`, `/clear`, `/new`, `/resume`,
  `/analytics`, `/compact`, `/tasks`, `/status`, `/cost`, `/init`, `/login`,
  `/logout`, `/version`, `/commit`, `/code-review`, `/exit`.
- Keyboard shortcuts: `Esc` to interrupt, `Ctrl+C` to quit, `Shift+Tab` to
  cycle approval mode, `Ctrl+A/E` line navigation, `Ctrl+U` kill line, plus
  menu and history navigation.
- `@`-file references: fuzzy workspace search, ↑/↓ to pick, enter/tab to
  insert into the prompt.
- `ask_followup_question` renders a selectable menu (arrow keys, number
  quick-pick, free-text answer).
- `attempt_completion` renders a bordered "✔ Task completed" card.
- Input box with top/bottom rule borders, history (↑/↓), multi-char paste
  (a trailing newline submits), and a slash-command autocomplete menu.
- Two built-in Axon models (`axon-code-2-5-pro` default,
  `axon-eido-3-code-pro`, `axon-code-2-5-mini`) plus a `customModels`
  setting for adding more; `/model` opens a scroll-and-select picker and
  the choice persists across sessions.
- Browser-based device-flow authentication with polling (no copy/paste):
  `orbcode login` or `/login` opens the MatterAI authorize dialog, and the
  token is handed out exactly once. `MATTERAI_TOKEN` and a settings.json
  `apiKey` provide non-interactive overrides.
- Token-based backend routing: a JWT whose payload has `env: "development"`
  automatically routes API calls to `http://localhost:3000`, matching the
  extension's behavior. `MATTERAI_BACKEND_URL` / `MATTERAI_APP_URL` override
  the defaults for local development.
- Headless non-interactive mode (`-p` / `--prompt`) that prints only the
  final response, with `--yolo` to auto-approve edits and safe commands.
  Followup questions are auto-answered with "proceed with best judgment".
- Configuration in `~/.orbcode/`: `config.json` (app state) and
  `settings.json`, with a project-level
  `.orbcode/settings.json` layering on top. `autoApproveEdits` and
  `autoApproveSafeCommands` set session defaults for the approval prompts.
- Session persistence under `~/.orbcode/sessions/<id>.json` powering
  `/resume` and `--resume <id>`. Task titles are fetched once per task
  from the backend and written into the session file.
- Backend-compatible request headers (`X-Title`, `X-AxonCode-Version`,
  per-task `X-AxonCode-TaskId`, `User-Agent: orbcode-cli/<version>`,
  `X-AXON-REPO` from the git remote or folder name) and a streaming
  client that handles cumulative-content dedup, `<think>` routing, and
  tool-call fragment accumulation.
- Usage and cost surfacing: `/status` and `/cost` show the plan, usage
  percentage, remaining reviews, the credits reset date, and the live
  session cost, sourced from `/axoncode/profile` and the API's usage
  chunks.
- Native tool schemas ported byte-identical from the Orbital extension
  for: `read_file`, `file_edit`, `multi_file_edit`, `file_write`,
  `list_files`, `search_files`, `execute_command`, `web_search`,
  `web_fetch`, `update_todo_list`, `ask_followup_question`,
  `attempt_completion`. Inactive schemas kept under `src/tools/schemas/`
  for future IDE integrations.
- Agent loop with up to 50 steps per turn, an `AbortController`-backed
  `Esc` interrupt that records a `<system_reminder>` in the
  conversation, and environment-details wrapping that matches the
  extension's prompt contract.
- npm release automation: GitHub Actions workflow gated on a `vX.Y.Z`
  tag on `main`, with a `prepublishOnly` typecheck + build, tag/version
  matching, and a "skip if already published" check. `workflow_dispatch`
  is exposed as a manual fallback.
- Self-contained test harnesses:
  - `test-ui.mjs` drives the real `App` (ink-testing-library technique)
    for header, slash menu, `/help`, `/model` switching, message
    submission, and a live round-trip to the API gateway.
  - `test-device-auth.mjs` spins up a local HTTP mock of the backend
    endpoints and verifies code issuance, pending polls, authorization,
    one-time token pickup, and expiry semantics.
- `CONTRIBUTING.md`, `SECURITY.md`, `RELEASE.md`, and an MIT `LICENSE`.

### Changed

- Prompts and the agent role definition were cleaned up and reformatted
  for terminal output.
- Environment details and user messages are stripped of XML-style tags
  before being shown to the model, matching the extension's prompt
  contract.

### Fixed

- Cross-platform shell detection and path handling in
  `execute_command` (Windows vs POSIX, `cmd` vs `bash`, etc.).

[Unreleased]: https://github.com/MatterAIOrg/OrbCode/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/MatterAIOrg/OrbCode/compare/v0.4.8...v0.5.0
[0.4.0]: https://github.com/MatterAIOrg/OrbCode/compare/v0.3.4...v0.4.0
[0.3.4]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.3.4
[0.3.3]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.3.3
[0.3.2]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.3.2
[0.3.1]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.3.1
[0.3.0]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.3.0
[0.2.4]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.2.4
[0.2.3]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.2.3
[0.2.0]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.2.0
[0.1.14]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.14
[0.1.13]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.13
[0.1.8]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.8
[0.1.5]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.5
[0.1.4]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.4
