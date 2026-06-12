# OrbCode CLI

Agentic coding in your terminal — powered by **Axon models by MatterAI**.

OrbCode CLI is a standalone terminal port of the Orbital extension: the same Axon
models, the same native tool schemas, the same MatterAI auth backend — rebuilt from
scratch as an interactive TUI with streaming chat, live thinking display, tool
activity rows, edit/command approvals, and todo tracking.

---

## Table of contents

- [Install](#install)
- [Updating / relinking](#updating--relinking)
- [Usage](#usage)
- [Authentication](#authentication)
- [Models](#models)
- [The TUI](#the-tui)
- [Slash commands](#slash-commands)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Approvals & safety](#approvals--safety)
- [Headless mode](#headless-mode)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Tools](#tools)
- [Agent loop](#agent-loop)
- [Development](#development)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Install

Requires **Node.js >= 20**.

```bash
npm install -g @matterailab/orbcode
```

Then, from any project directory:

```bash
orbcode
```

To update later: `npm update -g @matterailab/orbcode` (or re-run the install command).

### From source (development)

```bash
git clone https://github.com/MatterAIOrg/OrbCode.git
cd OrbCode
npm install
npm run build
npm link        # exposes the global `orbcode` command
```

## Updating / relinking

`npm link` creates a **symlink** to this repo, so after pulling changes you only
need to rebuild — no relink required:

```bash
npm run build   # the linked `orbcode` command picks this up immediately
```

Relink only when the package **name or bin entry changes** (e.g. the package was
renamed `orbitalcode` → `orbcode`):

```bash
npm unlink -g orbitalcode   # remove a stale link under the old name (once)
npm link
```

The version reported by `orbcode --version` is read from `package.json` at
runtime — bumping the version there is all that's needed.

## Usage

```
orbcode                 start an interactive session in the current directory
orbcode "<prompt>"      start an interactive session with an initial prompt
orbcode login           sign in to MatterAI (browser device flow)
orbcode -p "<prompt>"   run a single prompt non-interactively, print only the final response
orbcode -p "…" --yolo   non-interactive with edits/commands auto-approved
orbcode --model <id>    use a specific model for this run (also -m)
orbcode --resume <id>   resume a previous session by id (also -r)
orbcode --version       print version
orbcode --help          show help
```

The TUI always takes over the full terminal screen on launch (prior shell
output stays in scrollback).

The directory you launch from becomes the **workspace directory**: the default
target for file operations and commands, and the file listing the model sees in
its environment details.

## Authentication

Browser-based device flow with polling (no copy/paste needed):

1. `orbcode login` (or `/login` in the TUI) calls `POST /orbcode/auth/start` on
   the MatterAI backend, which issues a one-time 48-hex **device code**
   (10-minute lifetime, stored in redis).
2. The CLI opens
   `https://app.matterai.so/orbital?loginType=orbcode&devicecode=<code>` in your
   browser:
   - **Already signed in** → the webapp shows the **Authorize OrbCode CLI**
     dialog immediately.
   - **Not signed in** → you're redirected to sign-in first. The `devicecode`
     query param is preserved through the OAuth state (Google/Microsoft) and the
     email/password path, so the authorize dialog appears right after sign-in.
3. Clicking **Authorize** binds your session token to the device code
   (`POST /orbcode/auth/authorize`).
4. Meanwhile the CLI polls `GET /orbcode/auth/poll?devicecode=…` (every 3s by
   default, bounded by the code's lifetime). The token is handed out **exactly
   once** — the redis key is deleted on first successful poll.
5. The CLI verifies the token against the profile endpoint and saves it.

Fallbacks & overrides:

- **settings.json key**: set `apiKey` in `~/.orbcode/settings.json` (or a
  project's `.orbcode/settings.json`) to skip login. The login screen itself is
  browser-redirect only.
- **Env token**: set `ORBCODE_TOKEN` to skip login entirely (takes precedence
  over everything).
- **Dev endpoints**: `ORBCODE_BACKEND_URL` (default `https://api.matterai.so`)
  and `ORBCODE_APP_URL` (default `https://app.matterai.so`) override where the
  device flow points — useful against a local backend/webapp.
- Tokens are MatterAI JWTs. A token whose payload has `env: "development"`
  automatically routes API calls to `http://localhost:3000`, matching the
  extension's behavior.

Sign out with `/logout` (removes the saved token).

## Models

The two Axon models are built in; `/model` opens a scroll-and-select picker
(`/model <id>` still selects directly). Additional models can be declared via
`customModels` in settings.json. The choice persists across sessions.

| id                     | context | max output | pricing            |
| ---------------------- | ------- | ---------- | ------------------ |
| `axon-eido-3-code-pro` | 400k    | 64k        | $3/M in · $9/M out |
| `axon-code-2-5-pro`    | 400k    | 64k        | $2/M in · $6/M out |
| `axon-code-2-5-mini`   | 400k    | 64k        | free               |

`axon-code-2-5-pro` is the default. All three support native JSON tool calls and
image input. Cost comes from the API's usage chunks (`is_byok`-aware) and is
shown in the status bar.

## The TUI

```
  ___         _       ____             _
 / _ \  _ __ | |__   / ___|  ___    __| |  ___
| | | || '__|| '_ \ | |     / _ \  / _` | / _ \
| |_| || |   | |_) || |___ | (_) || (_| ||  __/
 \___/ |_|   |_.__/  \____| \___/  \__,_| \___|
```

- **Streaming responses** rendered as markdown (headers, lists, code fences,
  inline code, links) via a lightweight ANSI renderer.
- **Thinking**: reasoning streams live under `✦ Thinking…` (last few lines,
  dimmed) and collapses to `✦ Thought for Ns` when done. `ctrl+o` toggles
  expanded thinking for subsequent turns. Reasoning arrives from the API as
  `reasoning`/`reasoning_content` deltas or inline `<think>…</think>` blocks —
  all are routed to the thinking display.
- **Tool rows**: each tool call shows a formatted name ("Read File", "Execute
  Command"…), one-line summary (file path, command, query…), live "running"
  state, then `✓`/`✗` with a short result preview.
- **Edit diffs**: file-modifying tools render a real diff — stats header
  ("Added 2 lines, removed 1 line"), line-number gutter, red/green backgrounds —
  both in the approval prompt (before anything is written) and in the finished
  tool row.
- **Tasks**: the model maintains a checklist via `update_todo_list`; it renders
  as a compact Tasks panel (`□` pending / `◧` in progress / `■` done).
- **@-references**: type `@` in the input to fuzzy-search workspace files;
  ↑/↓ to choose, enter/tab inserts the top/selected match into the prompt.
- **Followup questions**: `ask_followup_question` renders a selectable menu
  (arrow keys, number quick-pick, or free-text answer).
- **Completion**: `attempt_completion` renders a bordered "✔ Task completed"
  card with the result.
- **Status bar**: approval mode (`⏵⏵ accept edits on`, shift+tab to cycle),
  busy state, model name, context token usage, and session cost.
- **Input box**: top/bottom rule borders with a `❯` prompt, history (↑/↓),
  cursor movement (←/→, ctrl+a/e), kill line (ctrl+u), multi-char paste (a
  trailing newline submits), and a slash-command autocomplete menu when the
  line starts with `/`. Every menu in the CLI (slash commands, @-files, model
  picker, session picker, followups) is navigable with ↑/↓ and selectable with
  enter; a partial command like `/mod` + enter runs the highlighted match.

## Slash commands

| command      | action                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| `/help`      | list commands                                                                                         |
| `/model`     | scrollable model picker (`/model pro` / `/model mini` / full id selects directly)                     |
| `/clear`     | clear the screen only, like the terminal's `clear` — the conversation and context continue            |
| `/new`       | start a fresh conversation/session with a clean slate                                                 |
| `/resume`    | pick a previous session for this directory and continue it (screen is cleared, conversation replayed) |
| `/analytics` | open the MatterAI analytics dashboard (app.matterai.so/orbital) in the browser                        |
| `/compact`   | summarize the conversation and replace history with the summary                                       |
| `/tasks`     | print the current task list                                                                           |
| `/status`    | version, model, account, gateway, context usage, cost, approval modes                                 |
| `/cost`      | show session cost and fetch account balance                                                           |
| `/init`      | analyze the codebase and create/improve `AGENTS.md`                                                   |
| `/login`     | start the browser sign-in flow                                                                        |
| `/logout`    | remove the saved token                                                                                |
| `/version`   | print the CLI version                                                                                 |
| `/exit`      | quit                                                                                                  |

## Keyboard shortcuts

| key                 | action                                                                 |
| ------------------- | ---------------------------------------------------------------------- |
| `Esc`               | interrupt the running turn (or cancel login polling / close a menu)    |
| `Ctrl+C`            | quit                                                                   |
| `Ctrl+O`            | toggle thinking display for the whole transcript (past turns included) |
| `Shift+Tab`         | cycle approval mode: ask → accept edits → auto-approve                 |
| `↑` / `↓`           | input history, or navigate any open menu                               |
| `Ctrl+A` / `Ctrl+E` | start / end of line                                                    |
| `Ctrl+U`            | clear the input line                                                   |

## Approvals & safety

Read-only tools (read/list/search/web/todos) run without prompting. Mutating
tools prompt first:

- **File edits** (`file_edit`, `multi_file_edit`, `file_write`) — prompt shows
  the target; `y` allow once, `n` deny, `a` allow for the rest of the session.
- **Commands** (`execute_command`) — prompt shows the exact command line. The
  model classifies commands with an `isDangerous` flag; dangerous commands
  (deletes, force-pushes, system changes…) can **never** be auto-approved — no
  `a` option, and `--yolo`/session-approval don't apply.

A denial is reported back to the model as "The user denied this operation." so
it can adjust course rather than fail.

## Headless mode

```bash
orbcode -p "explain the build pipeline in this repo"
orbcode -p "fix the lint errors" --yolo
```

Prints **only the final content** to stdout (the completion result, or the last
assistant message) — no tool activity, no intermediate text. Errors go to
stderr. Without `--yolo`, edit/command approvals are auto-denied (read-only
analysis). Followup questions are auto-answered with "proceed with best
judgment".

## Configuration

Two kinds of files under `~/.orbcode/`:

- **`config.json`** — state written by the app itself (login token, chosen
  model, approval defaults). Created on first save, mode 0600.
- **`settings.json`** — user-managed configuration, Claude-Code style. Created
  automatically as an empty `{}` on first run so it's easy to find. A
  project-level `.orbcode/settings.json` in the working directory layers on
  top of the user-level file.

```json
{
  "apiKey": "<token used instead of logging in>",
  "baseUrl": "https://my-gateway.example.com/v1",
  "model": "my-custom-model",
  "autoApproveEdits": false,
  "autoApproveSafeCommands": false,
  "customModels": [
    {
      "id": "my-custom-model",
      "name": "My Custom Model",
      "contextWindow": 128000,
      "maxOutputTokens": 32000,
      "inputPrice": 0.000001,
      "outputPrice": 0.000002
    }
  ],
  "env": { "MY_VAR": "value" }
}
```

All keys are optional. `customModels` entries appear in the `/model` picker
alongside the built-in Axon models; `baseUrl` points the chat client at any
OpenAI-compatible gateway; `env` is applied to the process at startup.
Precedence: env vars > project settings.json > user settings.json >
config.json.

Sessions are stored in `~/.orbcode/sessions/<id>.json` and power `/resume`
and `--resume <id>`.

| env var               | effect                                                            |
| --------------------- | ----------------------------------------------------------------- |
| `ORBCODE_TOKEN`       | auth token (overrides everything)                                 |
| `ORBCODE_API_KEY`     | same as `apiKey` in settings.json                                 |
| `ORBCODE_BASE_URL`    | same as `baseUrl` in settings.json                                |
| `ORBCODE_MODEL`       | model override (what `--model` sets internally)                   |
| `ORBCODE_CONFIG_DIR`  | config directory (default `~/.orbcode`)                           |
| `ORBCODE_BACKEND_URL` | device-auth backend (default `https://api.matterai.so`)           |
| `ORBCODE_APP_URL`     | webapp for the authorize page (default `https://app.matterai.so`) |

`autoApproveEdits` / `autoApproveSafeCommands` set the session defaults for the
approval prompts (dangerous commands still always prompt); shift+tab cycles
them at runtime.

## Architecture

```
src/
  index.tsx          entry: arg parsing, interactive vs -p (headless) mode
  branding.ts        product name, logo, colors; VERSION read from package.json
  headless.ts        non-interactive -p runner
  config/settings.ts load/save ~/.orbcode/config.json
  auth/auth.ts       device flow (start/poll), JWT→backend-URL mapping,
                     profile/balance fetch, token verification
  api/
    models.ts        the two Axon models (ported from the extension registry)
    client.ts        OpenAI-compatible streaming client → api2.matterai.so/v1/web
    stream.ts        chunk model: text / reasoning / native_tool_calls / usage
    headers.ts       X-AxonCode-Version, X-AxonCode-TaskId, X-AXON-REPO, …
  prompts/system.ts  system prompt: agent roleDefinition + tool guide (ported
                     verbatim from the extension) + CLI system-info section
  tools/
    schemas/         native-tools JSON schemas, copied verbatim from the extension
    executors/       CLI implementations (fs, child_process, search, web)
    index.ts         dispatch, approval classification, call summaries
  core/
    agent.ts         the agent loop (see below)
    events.ts        AgentEvent model consumed by the UI
  ui/
    App.tsx          main Ink app: static finalized rows + dynamic streaming area
    LoginView.tsx    device-flow login screen with paste fallback
    components/      Header, InputBox, rows, ApprovalPrompt, FollowupPrompt,
                     Spinner, StatusBar
    markdown.ts      markdown → ANSI renderer
```

**Streaming** faithfully ports the extension's handler quirks: cumulative
content dedup (some backends re-send full content), `<think>` blocks routed to
reasoning, both `reasoning` and `reasoning_content` delta fields, tool-call
fragments accumulated by index (id/name in the first delta, argument chunks in
the rest), and cost taken from the final usage chunk.

**Requests** carry the extension-compatible headers (`X-Title`,
`X-AxonCode-Version`, `User-Agent: orbcode-cli/<version>`, per-task
`X-AxonCode-TaskId`, and `X-AXON-REPO` set from the git remote or folder name).

**Task titles**: after the first turn, the backend-generated task title is
fetched once per task from `/axoncode/meta/<taskId>` (with retries, like the
extension). It shows in the status bar, is written into the session file (so
`/resume` lists real titles), and becomes the terminal window title:
`<title> (orbcode)`.

**Usage data**: `/status` and `/cost` fetch `/axoncode/profile` and show the
plan, usage percentage (used/remaining), remaining reviews, and the credits
reset date — the same data as the extension's profile view.

## Tools

Active in the CLI (schemas byte-identical to the extension's `native-tools`):

| tool                       | executor notes                                                                               |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `read_file`                | line-numbered output (`LINE\|content`, 6-char pad), 1000-line cap, offset/limit              |
| `file_edit`                | single replacement; unique-match enforcement; `replace_all`; empty `old_string` = whole file |
| `multi_file_edit`          | batched edits grouped per file, per-edit OK/FAILED results                                   |
| `file_write`               | creates parent dirs, full-content writes                                                     |
| `list_files`               | optional recursive, ignores node_modules/.git/build dirs, 800-entry cap                      |
| `search_files`             | JS regex search with glob `file_pattern` (picomatch), 300-match cap, binary skip             |
| `execute_command`          | user's shell, 120s timeout, 30k output cap, optional cwd                                     |
| `web_search` / `web_fetch` | proxied through the MatterAI backend with your token                                         |
| `update_todo_list`         | drives the TUI todo panel                                                                    |
| `ask_followup_question`    | interactive menu in the TUI                                                                  |
| `attempt_completion`       | ends the turn with a completion card                                                         |

Present in `tools/schemas/` but **inactive** (need IDE services): `codebase_search`,
`lsp`, `list_code_definition_names`, `use_skill`, `check_past_chat_memories`,
`browser_action`, `generate_image`, `new_task`, `switch_mode`,
`fetch_instructions`, `run_slash_command`.

## Agent loop

Per user message (`core/agent.ts`):

1. The first message is prefixed with `<environment_details>` (workspace file
   listing, git branch/status, time); every user message is wrapped in
   `<user_query>` tags, matching the extension's prompt contract.
2. Stream a completion (system prompt + history + tool schemas, temperature
   0.2). Text/reasoning deltas are forwarded to the UI as they arrive;
   tool-call fragments are accumulated.
3. If the model made tool calls: each one is summarized, approval is requested
   when required, the executor runs, and the result is appended as a
   `role: "tool"` message. `ask_followup_question` blocks on the user's answer;
   `attempt_completion` ends the turn.
4. Repeat (max 50 steps per turn) until a plain text response or completion.

`Esc` aborts the in-flight request via `AbortController`; the interruption is
recorded in the conversation as a `<system_reminder>` so the model knows.

## Development

```bash
npm run dev         # run from source (tsx)
npm run build       # compile to dist/
npm run typecheck   # tsc --noEmit
```

Source-of-truth rule: behavior is **ported from the Orbital extension repo**
(tool schemas under `src/core/prompts/tools/native-tools`, prompts in
`src/core/prompts/`, models in `src/api/providers/kilocode-models.ts`) — keep
schemas byte-identical rather than editing them here.

Backend/web pieces of the device-auth flow live in:

- `gravity-console-backend` → `src/controller/orbcodeAuthController.ts`
  (+ OAuth state in `router.ts`, callbacks in `authController.ts`)
- `gravity-console-webapp` → authorize dialog in `src/App.js`, sign-in q-p
  preservation in `src/layouts/authentication/sign-up/index.js`

## Tests

```bash
node test-ui.mjs           # in-process TUI test with a fake TTY
node test-device-auth.mjs  # device-auth polling flow against a local mock
```

- `test-ui.mjs` drives the real App (ink-testing-library technique): header,
  slash menu, `/help`, `/model` switching, message submission, and a **live**
  round-trip to the API gateway — the bundled fake token yields a clean 401
  error row. Self-contained: writes its own config fixture to
  `/tmp/orbcode-test-config`.
- `test-device-auth.mjs` spins up a local HTTP mock of the backend endpoints
  and verifies: code issuance, pending polls, authorization, one-time token
  pickup, and expiry semantics.

## Troubleshooting

- **`orbcode: command not found`** — run `npm link` in this repo; check
  `npm prefix -g`'s bin dir is on your PATH.
- **`--version` shows an old version** — rebuild (`npm run build`); the linked
  command runs `dist/`, and the version is read from `package.json` at runtime.
- **Stale link after the rename** — `npm unlink -g orbitalcode && npm link`.
- **Login times out** — the device code lives 10 minutes; press Enter to retry,
  or paste a token manually. Against a local stack, set `ORBCODE_BACKEND_URL`
  and `ORBCODE_APP_URL`.
- **401 on chat** — token expired: `/logout` then `/login`.
- **Keyboard input does nothing** — OrbCode needs a real TTY (raw mode); it
  won't accept piped stdin. Use `-p` for non-interactive runs.
- **`EPERM: operation not permitted` opening `bin/orbcode.js` on macOS** —
  the repo lives in a protected folder (Documents, Desktop, Downloads) and the
  terminal app hasn't been granted access to it. Allow it in System Settings →
  Privacy & Security → Files and Folders (or Full Disk Access) for that
  terminal, then restart it. Terminals that already prompted for access (e.g.
  iTerm) keep working. A normal global install (`npm install -g @matterailab/orbcode`) is
  unaffected because it lives outside protected folders.

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for how to
set up a development environment, run the tests, and submit a pull request.
Bug reports and feature requests go to
[GitHub Issues](https://github.com/MatterAIOrg/OrbCode/issues).

## License

[MIT](LICENSE) © MatterAI
