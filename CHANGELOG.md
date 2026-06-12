# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  token is handed out exactly once. `ORBCODE_TOKEN` and a settings.json
  `apiKey` provide non-interactive overrides.
- Token-based backend routing: a JWT whose payload has `env: "development"`
  automatically routes API calls to `http://localhost:3000`, matching the
  extension's behavior. `ORBCODE_BACKEND_URL` / `ORBCODE_APP_URL` override
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

[Unreleased]: https://github.com/MatterAIOrg/OrbCode/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.8
[0.1.5]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.5
[0.1.4]: https://github.com/MatterAIOrg/OrbCode/releases/tag/v0.1.4
