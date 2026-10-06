# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [6.9.7] - 2026-10-06

### Added

- **Effort selector for GLM 5.3, GLM 5.3 Flash, Gemini 3.8 Flash and DeepSeek V4.1 Flash.** `/effort` opens a Faster ↔ Smarter slider (low · medium · high · max) for the current model: ←/→ to adjust, Enter to save, `s` to apply it to this session only. `/effort <level>` sets it directly, ←/→ in `/model` adjusts the highlighted model's effort, and the status bar shows the level in effect. The default is Medium. Picks are saved per model in `~/.orbcode/config.json` and read on every request, so every chat on the machine (new, resumed or already running) uses them until changed. OrbCode sends the level as `X-MATTERAI-REASONING-EFFORT`; the backend maps it to what the serving gateway accepts (e.g. GLM has no medium tier, so it runs at high; Fireworks tops out at high). Which models get the selector comes from the catalog's `reasoning_efforts`, with a built-in fallback for older backends.
- **Confirm before resuming a session with a cold prompt cache.** The gateway keeps a conversation's prompt cache for 5 minutes; after that, the first resumed turn re-reads the whole context at the uncached input price. `/resume` and `orbcode --resume <id>` now show how long the session has been idle, how large it is, and what resuming will cost as a share of your weekly usage limit (monthly on Lite, dollars for your own provider keys). The share comes from the backend's new `GET /axoncode/usage/estimate`, which prices the request exactly like a real one; if it can't be reached, the prompt shows the context size without a cost figure. You can then resume, or start a new conversation and pull the old one in later with `/task`. The prompt appears for any cold session with 100k+ tokens of context (the share fills in once the backend answers), and for smaller ones when the cost is at least 1% of the window; estimates are prefetched while the `/resume` picker is open so picking a session doesn't wait on the network. It's skipped when a prompt is passed alongside `--resume <id>`.

### Fixed

- **Compaction no longer leaves a conversation stuck.**
  - A "context too long" error from the provider now compacts and retries the step instead of failing the turn; before, every following turn hit the same error.
  - A history that has already outgrown the window (e.g. a session resumed on a smaller-window model) still compacts: the summary request is trimmed to fit (older tool results stubbed, oldest turns dropped), with smaller budgets tried if the provider's real window is tighter than the catalog's.
  - The 80% check now counts tool output and new input added since the last usage report, not just the last reported size.
  - A failed auto-compaction is retried on the next turn instead of staying off for the rest of the session.
  - A user message that triggers compaction as a turn starts is kept verbatim after the summary.
- **`read_file` caps characters as well as lines** (100k per file, 200k per call), so a minified bundle or a file of very long lines can't flood the context in one read.
- **Your model and its effort now survive a restart.** Models that only exist in the backend catalog (e.g. DeepSeek V4.1 Flash) weren't known until `/v1/models` answered, so on startup the saved model fell back to GLM 5.3 Flash and its effort to medium. The last fetched catalog is now cached in `~/.orbcode/models-cache.json` and loaded before settings, the saved model is restored once the live catalog arrives, and the plan-default logic reads the saved model from disk instead of the fallback.
- **A replaced conversation no longer leaks into the next one.** `/new`, `/resume`, sign-in/out and MCP reloads now abort the in-flight turn and drop any events, approval requests or follow-up questions it emits while unwinding, so a turn that was still running can't stream into the new conversation's transcript.

## [6.9.6] - 2026-10-06

### Added

- **`--baseUrl` and `--apiKey` flags for headless mode.** Both are optional and route the request through an OpenAI-compatible endpoint instead of the MatterAI gateway. `--baseUrl` alone is enough when the endpoint doesn't require auth. When `--baseUrl` is given without `--model` (or `MATTERAI_MODEL`), the model defaults to `gpt-4o`. These flags set `MATTERAI_LLM_BASE_URL` / `MATTERAI_LLM_API_KEY` — deliberately distinct from the existing `MATTERAI_BASE_URL` / `MATTERAI_API_KEY`, which override the gateway URL and auth token and would otherwise break backend calls (models list, `/usage`, auth).
- **Structured headless output with `--json`.** `orbcode -p "…" --json` prints exactly one JSON object to stdout and nothing else: `{ ok, model, result, usage: { inputTokens, outputTokens, cost, totalCost }, sessionId, error }`. The `model` field reports the model actually used (so callers can verify the requested model ran), `usage` accumulates token counts and cost across the whole run, and `error` is `null` on success. The "Session saved…" line stays on stderr, so stdout is pure JSON.
- **`--require-model` to fail fast on an unknown model.** Previously an unknown `--model` warned to stderr and silently ran the default model instead. With `--require-model` (or automatically in `--json` mode) the CLI now exits non-zero with a clear error instead of running a different model than requested.
- **`--output-file <path>` for long-task results.** The agent is instructed to write its final structured result to the given path via `file_write`; headless mode reads that file and puts its contents in the envelope's `result` (falling back to the completion/text if the file is absent). This makes structured output reliable even when the model's final chat message is truncated or mangled.
- **`--verbose` event stream to stderr.** Prints tool-start/tool-end lines to stderr for observability during long agent runs, without polluting stdout.

## [6.9.5] - 2026-10-05

### Fixed

- **Task list no longer renders as a raw JSON array.** Some models pass the `update_todo_list` `todos` argument as a JSON array of `{status, content}` objects instead of the documented markdown checklist string, so the task panel showed the raw array. A shared normalizer (`src/utils/todos.ts`) now converts arrays — and JSON-encoded arrays — to the markdown checklist format at every entry point: tool execution, session resume, and rewind restore, so stale sessions saved with the raw array also render correctly.

## [6.9.4] - 2026-10-05

### Added

- **`/rewind`: go back to an earlier message.** Every message you send is now a checkpoint. `/rewind` (or `Esc` `Esc` on an empty prompt) lists them; pick one and OrbCode drops that message and everything after it from the conversation, and puts the message back in the prompt so you can edit it and send it again. When the agent edited files after that point, you choose whether to restore the code and conversation, the conversation only, or the code only. Before the agent first edits a file after a checkpoint, the file is backed up under `~/.orbcode/file-history/<session id>/`; rewinding puts it back, or deletes it if the agent created it. Files changed by `Bash` commands are not tracked. Checkpoints are saved with the session, so they survive `/resume`; compacting the conversation drops the checkpoints before it, and sessions saved before this release have none.

## [6.9.3] - 2026-10-03

### Changed

- **Version bump to 6.9.3.** No functional changes since v6.9.2; `package.json` version and the release branch/tag are advanced to `6.9.3` so the release workflow publishes from a `release/vX.Y.Z` branch.

## [6.9.2] - 2026-10-03

### Fixed

- **API-only models no longer leak into the model picker.** The `/v1/models` catalog fetch in `fetchDynamicModels` sent no `User-Agent`, so the backend's first-party check failed and appended the System One models (e.g. `fastino/gliner2.5-decide`) to the response; they were registered into the picker like regular chat models. The fetch now sends the standard `DEFAULT_HEADERS` (`orbcode-cli/<version>` User-Agent), matching every other backend call, and the backend hides System One models from first-party agents again.

### Changed

- **Shell-first exploration.** The `list_files` and `search_files` tools are no longer offered to the model; it now searches and lists with `rg`, `find`, `ls` and `git` through `execute_command`, the way Claude Code does, and the system prompt teaches the common patterns. To keep this from becoming a prompt on every search, read-only commands (`rg`, `grep`, `find` without `-exec`/`-delete`, `ls`, `cat`, `head`, `wc`, `git status/diff/log/show/grep`, and pipes or `&&` chains of these, with no redirects or command substitution) skip the approval prompt and run in parallel. Anything unrecognised still asks. Old sessions that called the removed tools still resume.

- **`execute_command` is now `Bash`, and it really runs bash.** The tool is renamed to match Claude Code. Commands now run in bash instead of whatever `$SHELL` is (fish and csh choke on the `rg … | head` / `&&` syntax the model writes): bash on macOS/Linux (zsh if it is your shell and bash is missing, then `/bin/sh`), and Git Bash on Windows, falling back to `cmd.exe` only when Git for Windows isn't installed. The system prompt states the shell, and warns the model when it is stuck on `cmd.exe`. Hook commands use the same shell. Hook matchers written as `execute_command` still match, and sessions saved with the old tool name still resume.

## [6.9.1] - 2026-09-30

### Added

- **Resume sessions from any directory.** `/resume` (and `orbcode --resume`) only listed sessions started in the current directory, so a conversation from another project was hard to find. The picker now shows this directory's sessions first and **Tab** switches to sessions from all directories, each labelled with where it lives; when there's nothing to resume here it opens on all directories. Resuming a session from another directory switches OrbCode's working directory to that session's directory and reloads the directory-bound state (project settings, MCP servers, project hook trust), so tools and `AGENTS.md` match the conversation. A session whose directory no longer exists shows an error instead of resuming.

### Fixed

- **No more deprecation warnings when installing or updating.** `openai@4` pulled in `node-fetch@2` → `whatwg-url@5` → `tr46`, which loads Node's deprecated built-in `punycode` (the `DEP0040` warning), and `formdata-node@4` → the deprecated `node-domexception` (the `npm warn deprecated` line on install/update). The `openai` SDK is upgraded to v7, which has no dependencies and uses Node's native `fetch`; the install drops from 203 to 180 packages. Updating *from* an older release can still show the `punycode` warning once, since that comes from the old version performing the update.

- **No more empty "●" rows between thinking and tool calls.** Models often stream whitespace-only content (e.g. a couple of newlines) right before a tool call, which rendered as a bare "●" message. Whitespace-only content is no longer shown while streaming, committed as a transcript row, saved to the session, or sent back to the model as assistant text, and blank rows in previously saved sessions render as nothing.

- **Picking GLM 5.3 Flash no longer reverts to another model.** The plan-aware default (the catalog's first model, on every plan while no catalog entry is flagged `freePlan`) was applied whenever the selected model equalled the static `DEFAULT_MODEL_ID` — which is `zai/glm-5.3-flash` — so choosing that model was immediately treated as "never chosen" and swapped for the catalog's first model. The selection now carries a persisted `modelExplicit` flag (set by `/model` picks, `settings.json` `model` and `MATTERAI_MODEL`; cleared by automatic plan defaults and fallbacks), and only a model that was never explicitly chosen is re-resolved, in both the TUI and headless mode.

## [6.9.0] - 2026-09-30

### Added

- **Whitespace-tolerant edits.** `file_edit` / `multi_file_edit` previously required `old_string` to match byte for byte, so a model that reconstructed indentation from memory (tabs vs spaces), or sent LF text for a CRLF file, got "old_string not found" and had to re-read the file and rewrite the edit — an extra model round trip plus another expensive edit-composition step. Matching now falls back, in order, to the same text with the file's line endings, then to a unique line-by-line match that ignores indentation and trailing whitespace (the replacement is re-indented to the file's own style). Replacement text always follows the file's line endings, so a CRLF file is never left with mixed endings. Ambiguous loose matches are still rejected, and successful loose matches say so in the tool result.
- **Actionable "not found" errors.** A failed match now returns the closest region of the file (up to 7 numbered lines with their exact whitespace), so the model can retry without another read.
- **Stale tool-result pruning.** Once context passes 40% of the model's window, bulky results of `read_file`, `search_files`, `list_files`, `execute_command`, `web_fetch` and `web_search` older than the four most recent tool results are sent as one-line stubs. The stored history and session files are untouched; only the outgoing request shrinks, and the boundary advances in batches of six so the request prefix (and the gateway's prompt cache) stays stable between prunes.
- **Automatic compaction.** When context passes 80% of the window, the conversation is summarized mid-turn and the turn continues from the summary, instead of degrading until the user runs `/compact`. A failed compaction is reported once and never retried within the session.
- **Loop warning.** The third identical tool call with identical output and no file edit in between gets an `[OrbCode]` note appended to its result telling the model that repeating it will not change anything. Previously this rule existed only as prompt text.
- **`bench/` harness benchmark.** Fixture repos, tasks with hidden-test verifiers, and a runner (`node --import tsx bench/run.ts --model <id> --label <name> [--reps N] [--suite core|extended|all] [--variant lean] [--steps]`) that drives the real agent loop in isolation and records steps, tokens, reasoning time, time-to-first-token, streaming and tool time, repeated calls and pass/fail. `bench/compare.ts` compares two result files. Not shipped in the npm package.

### Changed

- **Leaner system prompt.** The "Plan before editing", "Investigation efficiency" and "Verifying tool results and avoiding loops" sections asked the model to deliberate before every tool call and to write out a full change plan before editing. They are replaced by a four-line "Working style" block (act directly, locate → edit → check once, batch independent calls, never repeat an identical call more than twice).

### Fixed

- **Interrupts and timeouts now actually stop shell commands.** `execute_command` killed only the shell on timeout, so a grandchild process (`find /`, a pipeline stage) kept the output pipe open and the tool call hung until it exited on its own — in one benchmark run for 4.6 hours — and pressing Esc never stopped a running command at all. Commands now run in their own process group; a timeout or user interrupt kills the whole group, and the tool result says why the command stopped.

### Measured impact

Before/after on the 9-task benchmark (`bench/`, 2 runs per task per model, median per run; all runs pass unless noted):

| model | wall | steps | input tokens | pass |
|---|---|---|---|---|
| glm-5.3 | 122s → 81s (−33%) | 6 → 5 | −22% | 17/18 → 18/18 |
| glm-5.3-flash | 82s → 66s (−20%) | 5 → 5 | −12% | 18/18 → 18/18 |
| deepseek-v4.1-flash | 25s → 25s | 5 → 5 | −25% | 18/18 → 18/18 |
| gemini-3.8-flash | 72s → 73s | 11 → 11 | −15% | 17/18 → 17/18 |

The CRLF/tab-indented edit task shows the tolerant-edit change most clearly: glm-5.3-flash went from 15 steps / 202s to 5 steps / 38s, glm-5.3 from 12 steps / 275s to 6 steps / 53s.

## [6.8.7] - 2026-09-21

### Added

- **Force-send a queued message.** Messages typed while the agent is streaming are held in a FIFO queue and drained one per turn, so a queued message previously had to wait for the whole in-flight turn (including every tool call) to finish. The queue panel now shows a clickable `[send now]` action beside each message, and `ctrl+s` force-sends the next one in line. Either path jumps that message to the front of the queue and aborts the in-flight turn so it starts immediately; when nothing is in flight the queue drains directly.
- **Organization-scoped dynamic model catalog.** `fetchDynamicModels` now sends `X-KiloCode-OrganizationId` and `X-Org-Id` headers — from the new optional `organizationId` argument, falling back to `settings.organizationId` when omitted — so the gateway returns the models available to the user's organization instead of the global registry.

### Fixed

- **Session data no longer vanishes when quitting mid-turn.** Session persistence previously ran only in `runTurn`'s `finally` — when OrbCode was killed or the terminal closed while a turn was still running (a long multi-step turn can stream for many minutes), the entire in-flight turn's messages (the user prompt, every assistant response, and every tool call/result accumulated across all its steps) were never written to disk, so resuming showed the state from before that turn. The agent now persists right after the user message is pushed and after every model step, so a hard kill loses at most the single in-flight tool call. Session writes are also atomic now (write to a pid-suffixed temp file, then rename), so a crash mid-write can no longer truncate or corrupt the last good session file; a non-serializable value in history degrades to a safe replacer instead of throwing away the whole session; and save failures are surfaced as transcript errors instead of being silently swallowed.
- **A stale OrbCode process can no longer roll a session back.** Quitting with Ctrl+C previously did nothing (no handler existed), leaving zombie processes alive with the old conversation in memory; their next save would overwrite the session file with stale history, erasing turns written by a resumed session. Ctrl+C now interrupts the running turn (like Esc) and, when idle, exits through the same double-press confirmation as Ctrl+D. Additionally, `persist()` tracks the session file's last-known mtime and refuses to write when another process has written newer turns, warning instead of clobbering.

## [6.8.6] - 2026-09-15

### Fixed

- **Plan-aware default model.** The default model is now resolved from the live catalog instead of the hardcoded `DEFAULT_MODEL_ID`: free accounts default to the catalog entry the backend flags `freePlan`, every other plan to the first catalog entry (index 0, ordered by the catalog's `sortOrder`). `fetchDynamicModels` records the catalog order and each model's `freePlan` flag, and the new `getDefaultModelId(plan)` helper resolves the default. The TUI applies it once the catalog and the account plan have both loaded — only while the selection is still the untouched default, so an explicit pick is never overwritten — and headless mode applies it when no `--model` / `MATTERAI_MODEL` was requested.

## [6.8.5] - 2026-09-08

### Added

- **Auto-copy on text selection with toast notification.** Selecting text in the CLI TUI now automatically copies the selected text to the system clipboard (with fallback to OSC 52 terminal clipboard) and displays a floating toast notification ("✓ Text copied to clipboard") in the corner of the terminal that automatically dismisses after two seconds. The toast only appears when a clipboard mechanism actually succeeded.
- **Scroll-to-bottom hover chip.** When scrolled up in an active task (`effectiveScrollOffset > 0`), a floating hover chip (`↓ Scroll to bottom`) appears centered above the composer. Hovering highlights the chip, and clicking it (or pressing Esc when input is idle) smoothly snaps the viewport back to the live transcript edge. The click handler fires exactly once per press.

### Fixed

- **Terminal no longer hangs after quitting a session.** `/quit`, `/exit`, and Ctrl+D printed the "Session saved" line but the process stayed alive whenever a background handle (an MCP server child process still closing, an in-flight fetch socket, or an FFF watcher) kept the event loop busy, requiring Ctrl+C to get the prompt back. The interactive path now exits explicitly after the renderer is destroyed, matching the headless mode's behavior.
- **Working animation not triggered during response content streaming.** When reasoning finished and the model began streaming the final response content buffer, the "Working..." spinner animation failed to appear because the loading indicator was suppressed while `streamingText` was non-empty. In addition, `text-delta` set the busy state to "Responding" instead of "Working". Fixed by keeping the "Working..." spinner active below the streaming response text and accounting for its height during response streaming, ensuring the spinner animation runs throughout content generation.
- **Terminal line overlapping when pasting large or multiline text.** When a multiline or large text was pasted or submitted, `TranscriptViewport`'s `justifyContent="flex-end"` caused Yoga flexbox to squash row containers and assign overlapping vertical coordinates to subsequent transcript rows and streaming text, resulting in permanent character and line overlap. Fixed by driving transcript alignment through negative `marginTop` derived from `maxScrollOffset`, disabling flexbox squashing (`flexShrink={0}` on row wrappers), expanding tab characters in user blocks to prevent unexpected terminal wrapping, capping prompt input display height (the prompt window is sliced by wrapped rows — the same math as the height cap — so the rendered prompt can never exceed the height reported to the viewport), and collapsing multi-line pastes (3+ lines) and large pastes (200+ characters) into paste chips.

## [6.8.4] - 2026-09-05

### Fixed

- **Model picker now updates the header row's MODEL line.** Selecting a model in the picker updated `settings` and the agent, but the header row's `modelName` was a stale snapshot — the MODEL/WORKSPACE line only refreshed on `/new` or `/resume`. `switchModel` now patches the header row in place.

### Changed

- **Malformed tool-call JSON is now repaired instead of rejected.** Models that emit almost-JSON — unquoted strings (`"file_pattern": *.tsx`), unquoted keys, single quotes, trailing commas, Python literals (`True`/`None`), comments, XML-style tags interleaved where punctuation belongs (`"offset</longcat_arg_key>`), keys with dropped closing quotes (`"offset: 600`), or output truncated mid-call — no longer burn a round trip on a corrective error (weaker models repeated the same mistake on retry). A best-effort repair pass (`src/utils/jsonRepair.ts`) recovers the intended arguments, the tool executes with them, and a note on the tool result tells the model what actually ran; only truly unrecoverable arguments still return the corrective error. Session replay and the AI SDK history path use the same repair so the model sees its own repaired calls. Covered by `test/json-repair.test.ts` (`npm run test:json-repair`).
- **`search_files` numeric limits clamp instead of failing.** `max_results` and `context_lines` values that are fractional, out of range, or numeric strings now clamp to the nearest bound (or fall back to the default when non-numeric) instead of failing the whole search — e.g. `context_lines: 3` runs with 2.

## [6.8.2] - 2026-09-04

### Fixed

- **Update check now invalidates stale cache when the running version is newer than the cached `latest`.** Previously, a cached `latest` older than the running version (e.g. after `npm install -g` from another terminal) would hide a genuinely newer release until the 1-hour TTL expired. The cache is now treated as stale whenever `cached.latest < current`, forcing an immediate re-fetch.

## [6.8.1] - 2026-09-04

### Added

- **Dynamic model catalog synchronization.** OrbCode now fetches the active model catalog dynamically from the backend (`/v1/models`) on startup and when refreshing usage (`fetchDynamicModels`), registering returned OSS models into `BUILTIN_AXON_MODELS` and `AXON_MODELS` so newly added models appear in the picker without requiring hardcoded updates. Models the backend retires are pruned after a successful fetch (empty or failed responses never wipe the offline fallback), and the catalog's `iconUrl` / `costMultiplier` fields are captured on each model.
- **Provider badges in the model picker.** Terminals can't render the catalog's SVG provider icons, so picker rows show a text badge (`[Z.ai]`, `[Meta]`, `[DeepSeek]`, `[OpenAI]`, `[Google]`) — the TUI equivalent of the webapp's provider logos.
- **`orbcode usage` command.** Prints the weekly/monthly plan usage windows
  (percentage bars with reset times) and each tracked OSS model's share of
  the shared plan pool as weekly/monthly percentages, alongside the model's
  plan-cost multiplier (e.g. `5x cost`). The TUI's `/usage` and `/status`
  commands show the same per-model block. Percentages only — no credit
  amounts are exposed. Requires a logged-in token (`orbcode login`).

### Changed

- **Built-in model catalog is now OSS-first.** The built-in registry replaces
  the Axon models with seven OSS models served through the MatterAI gateway:
  `zai/glm-5.3-flash` (the new default), `zai/glm-5.3`,
  `deepseek/deepseek-v4-flash-0731`, `meta/muse-spark-1.3-contributor`,
  `gpt-5.6-luna`, `gpt-5.6-sol`, and `gemini-3.8-flash`. All seven expose a
  232K context window with 64K max output, are available on every plan, and
  carry their published per-token pricing. The 400K
  context variants and `axon-auto` are gone from the picker; a stored Axon
  model selection auto-resets to the new default on next launch, and a
  requested Axon id (`--model` / `MATTERAI_MODEL`) now warns and falls back
  to the default.
- **Model picker visible rows doubled to 12.** The scrollable model picker now shows 12 rows instead of 6 for better catalog visibility.
- **Rebranded tagline and descriptions.** Removed "powered by Axon models by MatterAI" from the CLI description, branding tagline, and system prompt role definition; now reads "by MatterAI".

## [6.8.0] - 2026-08-28

### Changed

- **Ported the 6.8.2 coding-harness update from the Orbital extension.**
  - `search_files` is now one-shot: ripgrep-first with FFF fallback, results bounded to the first 100 matches (default `max_results` 100), and cursor pagination removed from the model-facing schema and output. Capped results tell the model to refine the query instead of paginating.
  - Independent read-only tool calls (`read_file`, `search_files`, `list_files`, `list_code_definition_names`, `codebase_search`, `lsp`) at the start of an assistant response now execute concurrently (max 4) with results committed in model order; mutating and interactive tools stay serialized.
  - Malformed tool-call JSON now returns a corrective tool result that includes the raw arguments, so the model can re-issue the call with valid JSON instead of dead-ending.
  - Native tool schemas tightened for strict mode: optional parameters are now required with nullable types (`replace_all`, `recursive`, `follow_up`, `offset`/`limit`, `cwd`/`message`/`isDangerous`, and the inactive-in-CLI tool schemas), and `execute_command` guidance asks for an explicit safety classification.
  - System-prompt `search_files` guidance updated to the bounded one-shot behavior.

### Added

- **Investigation efficiency guidance in system prompt.** Added an "Investigation efficiency" section to the tool guide (`src/prompts/system.ts`) that directs the agent to classify comprehension questions separately from implementation tasks, form a one-line hypothesis before searching, read call sites rather than implementation internals, avoid reading prose/content when the question is about control flow, and stop exploring as soon as it can answer.
- **Zero-result guidance in `search_files`.** `searchFiles.ts` executor now appends actionable guidance when a search returns 0 matches, directing the model to tighten or simplify the regex, widen the path scope, try a different glob, or stop searching after 2+ failed attempts.
- **Native tool description improvements.** The `read_file` schema description now tells the model not to read file contents (prompt text, config values, prose) when investigating control flow, and not to re-read regions already read earlier. The `search_files` schema description now tells the model to scope the path to the narrowest plausible directory and to stop after 2+ zero-result searches.

### Changed

- **Default model is now `axon-auto-232k`.** The previous default
  (`axon-eido-3.2-code-mini-232k`) is preserved as a paid option (`axon-auto`
  now dynamically picks Code, Code Pro, or Flash for each task). Auto is
  available on every plan; the underlying Code, Code Pro, and 400K options it
  picks from still require the relevant paid plan to actually run.

### Changed

- **Eido 3.2 Mini tag removed; the default-tier option is `axon-eido-3.2-code`.**
  The bare-id model that used to carry the `-Mini` variant
  (`axon-eido-3.2-code-mini-{232k,400k}`) is now `axon-eido-3.2-code-{232k,400k}`,
  maps to the gateway id `axon-eido-3.2-code`, and is gated to Pro and above
  plans like Code Pro. Only the 232K Eido 3.2 Flash
  (`axon-eido-3.2-flash`) remains available on the Free plan — every 400K
  variant, including `axon-eido-3.2-flash-400k`, still requires Pro Plus or
  Ultra.
- **Two-window context convention (232K and 400K).** Auto
  (`axon-auto-200k` → `axon-auto-232k`) and Lumen
  (`axon-lumen-4-code-200k` → `axon-lumen-4-code-232k`) now share Eido 3.2's
  default context window of 232K. The 200K window is retired; every built-in
  Axon model exposes exactly a 232K and a 400K option. The
  `get200kAxonFallback` helper has been renamed to `get232kAxonFallback` and
  simplified to a single `-400k → -232k` rewrite (with a special case for the
  bare `axon-eido-3.2-flash` id).
- **Axon Eido 3.2 model family.** All built-in Eido 3 models (`axon-eido-3-flash`,
  `axon-eido-3-code-{pro,mini}-200k`, and their 400K variants) have been bumped
  to Eido 3.2 as `axon-eido-3.2-flash` and
  `axon-eido-3.2-code-{pro,mini}-{232k,400k}`. The default-tier options now
  advertise a 232K context window (`contextWindow: 232_000`) and the 232K suffix
  in their model id, while the 400K variants are unchanged. Default model
  updated to `axon-eido-3.2-code-mini-232k`. Mini pricing is now $2/M in and
  $6/M out; Flash pricing is now $0.6/M in and $1.8/M out, matching the
  gateway's Eido 3.2 rates. The `isEidoProAxonModel` and `is400kAxonModel`
  helpers recognise the new ids.
- **Axon Eido 3 Flash 400K context option.** Added `axon-eido-3-flash-400k`,
  a 400K context variant of the flash model that maps to the same
  `axon-eido-3-flash` gateway model. Gated to Pro Plus and Ultra plans like
  the other 400K options; the picker renders it under the 400K group and the
  200K fallback resolves to the bare `axon-eido-3-flash` id.

## [6.7.4] - 2026-08-04

### Added

- **Paste chips for large pasted text.** Pasting 500+ characters into the
  prompt input collapses the text into a removable chip above the prompt,
  named after the first few words of the pasted text. On submit the full text
  is merged back into the message at the exact cursor position where the paste
  happened, separated by two blank lines. Backspace with an empty prompt
  removes the most recent chip.

## [6.7.3] - 2026-08-04

### Changed

- **Axon Eido 3 Flash is now paid at $0.5/M in and $1.5/M out.** The built-in
  registry no longer marks `axon-eido-3-flash` as free; `inputPrice` and
  `outputPrice` are updated to match the new MatterAI API pricing. Flash usage
  now accrues session cost like the other Axon models.

## [6.7.2] - 2026-08-02

### Changed

- **Axon Eido 3 Pro is gated to Pro and above plans.** The model picker now
  locks the Eido 3 Pro 200k option on the free plan with a "Pro and above
  only" badge, and keeps the 400k option on Pro Plus and Ultra. Selecting an
  Eido 3 Pro model on an ineligible plan emits an error row, headless mode
  exits with a descriptive message, and a stored Eido 3 Pro selection on an
  ineligible plan auto-falls back to the default Eido model.

## [6.7.1] - 2026-07-31

### Added

- **Organization usage metrics.** OrbCode now reports metadata-only user-message events, model/version-aware accepted agent line counts, and newly observed Git commit line totals for AI-share, active-user, leaderboard, conversation, and client-version analytics. Git remotes are credential-sanitized, and prompt/file contents are never included.

## [6.7.0] - 2026-07-29

### Added

- **Axon Lumen 4 Code model support.** Added support for `axon-lumen-4-code` in 200K and 400K context variants (`axon-lumen-4-code-200k` and `axon-lumen-4-code-400k`). Lumen models are available on Pro Plus and Ultra plans.

## [6.6.8] - 2026-07-25

### Changed

- **Remove free tag from Axon Eido 3 Flash.** Removed `(free)` suffix from the Axon Eido 3 Flash model display name.

## [6.6.7] - 2026-07-22

### Changed

- **Version bump to 6.6.7.** No functional changes since v0.6.0;
  `package.json` version and the release branch/tag are advanced to `6.6.7`.

## [0.6.0] - 2026-07-22

### Changed

- **`search_files` rewritten on FFF with ripgrep fallback and pagination.** The
  native `search_files` tool now runs through the FFF (`@ff-labs/fff-node`)
  engine first — a persistent, watched file finder that keeps an in-memory index
  of the workspace — and falls back to the bundled `@vscode/ripgrep` binary (or
  system `rg`) when FFF is unavailable or a continuation fails. Results are
  compact (at most three matches per file), capped at 100 per page, and paginated
  via an opaque `cursor` string that is fingerprint-bound to the originating
  path, regex, and `file_pattern`; passing the literal word `none` is rejected
  with a clear error so the model can't continue a completed search. A rare FFF
  continuation failure restarts from page one with ripgrep and is flagged with
  `Restarted: yes` so repeated matches can be accounted for.
- **New `search_files` parameters.** `cursor` (opaque continuation token or
  null), `max_results` (1–100, default 50), and `context_lines` (0–2, default 0)
  replace the old fixed 300-match dump. `file_pattern` now accepts `null` for all
  files (the schema's `type` widened from `string` to `string|null`), and the
  system prompt's verbose quoting rules were replaced with concise pagination
  guidance. The tool description, schema, executor, and summary formatter were
  updated together.
- **Search results are cleaned for the TUI.** Pagination metadata (`Engine`,
  `Matches`, `Next cursor`, `Restarted`, `Warning`) is stripped from result
  previews and the restored display transcript so the visible rows show only
  file paths and matched lines.
- **Search engines are disposed cleanly on exit.** A `disposeSearchFiles` hook
  drains in-flight FFF and ripgrep operations, destroys persistent finders, and
  tears down child processes (SIGKILL escalation after 250ms) so the CLI never
  leaves a `rg` process or FFF library behind.
- **README tool table updated.** `search_files` now reads "FFF-first Rust-regex
  search, compact pagination, and bundled/system ripgrep fallback".

### Added

- **`test/search-files.test.ts`** — 11 tests covering FFF default selection,
  native pagination continuity, literal handling of route-directory
  metacharacters, opaque-cursor binding, fractional-limit rejection, ripgrep
  ignore/normalization consistency, adjacent-match preservation across pages,
  completed-search disambiguation, FFF continuation fallback during cleanup,
  and post-cleanup FFF re-initialization. Exposed via `npm run test:search`.

## [0.5.10] - 2026-07-22

### Changed

- **Batched `read_file` tool support.** Updated the native `read_file` tool to accept a `files` array (1-10 file regions) for batching independent reads in a single tool call. Clamps line limits to 200-1000 lines for region requests and formats returned regions with range and total file line labels when multiple regions are returned. Updated tool schema, executor, system prompt guidelines, and summary descriptions.

## [0.5.8] - 2026-07-21

### Added

- **Axon Eido 3 Pro and Mini now expose 200k and 400k context-window options.**
  Each model ships as two local entries — `axon-eido-3-code-{pro,mini}-200k`
  and `axon-eido-3-code-{pro,mini}-400k` — that share the same underlying base
  model on the MatterAI gateway. A new `gatewayModelId` field on `AxonModel`
  lets a local context-window option map to a different base model ID sent to
  the gateway, so the suffix only affects OrbCode's local context window.
- **400k context is gated to Pro Plus and Ultra plans.** A new
  `canUse400kContext(plan)` helper normalizes the plan name and unlocks the
  400k options only for `proplus` / `ultra`. The model picker renders the 400k
  rows dimmed with a "Only available in Pro Plus and Ultra plans" hint, skips
  them when navigating with ↑/↓/Tab, and refuses to select them via Enter or
  number keys. Selecting a 400k model from `/model` or the picker on an
  ineligible plan emits an error row and leaves the current model unchanged.
  Headless mode (`-p`) fetches `/axoncode/profile` and exits with a clear
  message if the requested 400k model isn't allowed. If a user without 400k
  access loads the app with a 400k model already in settings, OrbCode
  auto-falls back to the matching `-200k` variant.

### Changed

- **Default model is now `axon-eido-3-code-mini-200k`.** The previous default
  (`axon-eido-3-code-mini`, 400k) is preserved as the `-400k` option for
  eligible plans.
- **`/model pro` and `/model mini` short suffixes prefer the 200k variant.**
  The suffix matcher now also accepts `-<arg>-` infixes (so `pro` matches
  `axon-eido-3-code-pro-200k`) and sorts 200k matches ahead of 400k ones,
  keeping the short form usable on every plan.

## [0.5.7] - 2026-07-21

### Added

- **Paste files copied in the host file manager as attachments.** Copying a
  file in Finder/Explorer (or a `text/uri-list` copy on Linux/Wayland) and pasting
  into the composer now attaches the file, instead of pasting a meaningless path
  string. OrbCode reads the native file-list clipboard flavor — `public.file-url`
  on macOS via JXA, `FileDropList` on Windows via PowerShell, and `text/uri-list`
  on Linux via `wl-paste`/`xclip` — resolves each entry to a real path, filters to
  supported attachment types, and queues them exactly like drag-and-drop. When
  the clipboard holds no files (a plain text copy), the paste falls back to
  inserting the text as before. `useInput` exposes an optional `onPaste` hook so
  callers can consume a paste before it reaches the key handler.

## [0.5.6] - 2026-07-21

### Fixed

- **Shift+Enter now inserts a newline in terminals that send a bare linefeed.**
  Outside the Kitty keyboard protocol, many terminals encode Shift+Enter as a
  raw LF (linefeed) with no shift modifier, so OpenTUI surfaced it as a plain
  `linefeed` key — which the composer treated as an ordinary Enter and submitted
  the prompt instead of starting a new line. The input key mapper now recognizes
  a `linefeed` key as `return` with the `shift` flag set, so multiline input
  works consistently across terminals that don't implement the Kitty protocol.

### Changed

- **Attachment image-support partitioning is now a shared helper.** The logic
  that splits parsed attachments into image-capable and unsupported-image sets
  (used when the active model can't accept images) is extracted into
  `partitionAttachmentsByImageSupport`, so the partition rule has a single
  implementation and is covered by a dedicated unit test.

## [0.5.5] - 2026-07-20

### Added

- **`/create-skill` slash command.** Describe a repository-specific workflow in
  plain language and OrbCode creates or updates a reusable skill under
  `.orb/skills/<skill-name>/`, keeping any supporting scripts, references, and
  assets inside the same skill directory.
- **Figma design context (`figma_fetch` tool).** A new native tool fetches the
  full node tree, components, styles, and rendered image URLs for any
  `figma.com/design/`, `/file/`, or `/proto/` URL. Requests are authenticated
  against the MatterAI backend (`/axoncode/figma`), which uses the org's
  configured Figma access token so callers don't need to handle credentials.
- **Auto-fetch Figma URLs from user messages.** When a user pastes a Figma
  link into a prompt, the agent scans the message for Figma URLs and
  pre-fetches each one before the first model completion. The design data is
  injected as a tool result, so the model has visual + structural context
  from step 0 without having to discover and call `figma_fetch` itself.
  URLs are deduped and trailing punctuation is stripped.

### Fixed

- **Streaming responses stay visible above the input box.** The transcript's
  live edge is now anchored using its rendered layout instead of relying on
  approximate text-height calculations, so word-wrapped final lines are not
  clipped behind the composer.

## [0.5.1] - 2026-07-16

### Fixed

- Allow empty MCP settings objects in project config.

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

[Unreleased]: https://github.com/MatterAIOrg/OrbCode/compare/v6.7.1...HEAD
[6.7.1]: https://github.com/MatterAIOrg/OrbCode/compare/v6.7.0...v6.7.1
[6.7.0]: https://github.com/MatterAIOrg/OrbCode/compare/v6.6.8...v6.7.0
[6.6.7]: https://github.com/MatterAIOrg/OrbCode/compare/v0.6.0...v6.6.7
[0.6.0]: https://github.com/MatterAIOrg/OrbCode/compare/v0.5.10...v0.6.0
[0.5.10]: https://github.com/MatterAIOrg/OrbCode/compare/v0.5.8...v0.5.10
[0.5.8]: https://github.com/MatterAIOrg/OrbCode/compare/v0.5.7...v0.5.8
[0.5.7]: https://github.com/MatterAIOrg/OrbCode/compare/v0.5.6...v0.5.7
[0.5.6]: https://github.com/MatterAIOrg/OrbCode/compare/v0.5.5...v0.5.6
[0.5.5]: https://github.com/MatterAIOrg/OrbCode/compare/v0.5.1...v0.5.5
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
