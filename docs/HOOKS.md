# OrbCode Hooks — full reference

Hooks let you run your own shell commands at fixed points in OrbCode's agent
loop. Use them to **block** dangerous actions, **auto-approve** trusted ones,
**rewrite** tool inputs, **inject context** into the model, **format code**
after edits, **notify** yourself, or **keep the agent working** until a
condition is met.

OrbCode's hooks follow the **same contract as Claude Code's hooks**, so scripts
written for Claude Code work here with two tweaks: use `$MATTERAI_PROJECT_DIR`
(not `$CLAUDE_PROJECT_DIR`) and use OrbCode's tool names (`execute_command`,
`file_edit`, …) in your matchers. See [Differences from Claude
Code](#differences-from-claude-code).

> ⚠️ **Hooks run arbitrary shell commands with your user's privileges.** Hooks
> defined by a **project** (`.orbcode/settings.json`) are disabled until you
> explicitly trust them; see [Security](#security).

---

## Table of contents

- [Quick start](#quick-start)
- [Where hooks live](#where-hooks-live)
- [Configuration shape](#configuration-shape)
- [How a hook receives input (stdin)](#how-a-hook-receives-input-stdin)
- [How a hook controls OrbCode (exit codes & JSON)](#how-a-hook-controls-orbcode-exit-codes--json)
- [Events reference](#events-reference)
- [When multiple hooks match](#when-multiple-hooks-match)
- [Execution model](#execution-model)
- [Environment variables](#environment-variables)
- [Cookbook (copy-paste recipes)](#cookbook-copy-paste-recipes)
- [Debugging hooks](#debugging-hooks)
- [Differences from Claude Code](#differences-from-claude-code)
- [Security](#security)

---

## Quick start

Let's make OrbCode **block `rm -rf`** and **print the git branch on every
prompt**. Two steps.

**1. Create a hook script** at `~/.orbcode/hooks/guard.sh` and make it
executable:

```bash
mkdir -p ~/.orbcode/hooks
cat > ~/.orbcode/hooks/guard.sh <<'EOF'
#!/usr/bin/env bash
# OrbCode sends the tool call as JSON on stdin.
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
if printf '%s' "$cmd" | grep -Eq 'rm -rf (/|~|\*)'; then
  echo "Refusing to run a destructive command: $cmd" >&2
  exit 2          # exit 2 = block the tool; stderr is sent back to the model
fi
exit 0
EOF
chmod +x ~/.orbcode/hooks/guard.sh
```

**2. Register it** in `~/.orbcode/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "execute_command",
        "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/guard.sh" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "echo \"Git branch: $(git branch --show-current 2>/dev/null)\"" }
        ]
      }
    ]
  }
}
```

That's it — start OrbCode normally. Now any `rm -rf /` the model tries is
blocked with feedback, and every prompt gets the current branch appended as
context. (The recipes below use [`jq`](https://jqlang.github.io/jq/) to parse
JSON; install it with `brew install jq` / `apt install jq`, or parse with
Python/Node — see [Debugging](#debugging-hooks).)

---

## Where hooks live

Hooks are configured under the `hooks` key of `settings.json`. OrbCode reads
**two** files and **merges** their hooks (it does not overwrite):

| File | Scope | Typical use |
| --- | --- | --- |
| `~/.orbcode/settings.json` | user (all projects) | personal guards, notifications |
| `<project>/.orbcode/settings.json` | project (this repo) | repo-specific formatters, policies |

User hooks always run. **Project hooks are disabled until you trust them** (they
ship inside a repo and run shell commands — see [Security](#security)). Once
trusted, a project can **add** hooks without clobbering your global ones — for a
given event the user matchers come first, then the project matchers, and they
all execute. (Override the config directory with `MATTERAI_CONFIG_DIR`.)

Hooks are **not** written to `config.json` (the app's own state file) — they are
configuration you own.

---

## Configuration shape

```jsonc
{
  "hooks": {
    "<EventName>": [
      {
        "matcher": "<regex>",          // optional; omit or "*" = match everything
        "hooks": [
          {
            "type": "command",         // the only supported hook type
            "command": "<shell command or script path>",
            "timeout": 60               // optional, seconds (default 60)
          }
        ]
      }
    ]
  }
}
```

- **Event name** — one of the [events](#events-reference). Unknown names are ignored.
- **`matcher`** — a JavaScript regex tested against one field of the event (the
  tool name for `PreToolUse`/`PostToolUse`, `source` for `SessionStart`, etc.;
  see the per-event tables). The regex is **auto-anchored** (`^…$`), so
  `"execute_command"` matches exactly that tool name, not
  `"execute_command_extra"`; use `"a|b"` for alternation. Omit it, or use
  `"*"`, to match everything. An invalid regex falls back to an exact-string
  comparison.
- **`hooks`** — the commands to run when the matcher matches. You can list
  several; they all run.
- **`command`** — run through your shell (`$SHELL`, falling back to `/bin/sh`;
  `cmd.exe` on Windows). May be an inline command or a path to a script.
- **`timeout`** — per-command, in seconds. A hook that exceeds it is killed and
  reported as a non-blocking message. Default: **10s**.

---

## How a hook receives input (stdin)

Every hook command gets a **single-line JSON object on stdin**. All events
include these base fields:

| Field | Meaning |
| --- | --- |
| `session_id` | the current session/task id |
| `transcript_path` | path to the session's JSON transcript on disk |
| `cwd` | the workspace directory |
| `hook_event_name` | the event that fired (e.g. `"PreToolUse"`) |

Plus event-specific fields (see [Events reference](#events-reference)).

**The one-liner pattern** every recipe uses — read stdin once, then pull fields
out with `jq`:

```bash
input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name')
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')
```

You can also read fields straight from the environment where provided (e.g.
`$MATTERAI_PROJECT_DIR`).

---

## How a hook controls OrbCode (exit codes & JSON)

A hook influences OrbCode in **two ways**: its **exit code** (simple) and/or a
**JSON object printed on stdout** (precise). You can use either or both.

### Exit codes (the simple way)

| Exit code | Meaning |
| --- | --- |
| **0** | Success. For `UserPromptSubmit` and `SessionStart`, anything the hook prints on **stdout** is injected into the conversation as extra context. For other events, stdout is ignored. |
| **2** | **Blocking error.** What "block" means depends on the event (see below). The hook's **stderr** is used as the reason. |
| other (1, 3, …) | **Non-blocking error.** The agent continues; the hook's stderr is shown to you as a warning. |

What **exit 2** does per event:

| Event | Effect of exit 2 |
| --- | --- |
| `PreToolUse` | The tool is **not run**; stderr is sent to the model as the block reason. |
| `PostToolUse` | The tool already ran; stderr is sent to the model as feedback. |
| `UserPromptSubmit` | The prompt is **blocked** (not sent to the model); stderr is shown to you. |
| `Stop` | The agent is told to **keep going** instead of stopping; stderr explains why. |
| `SessionStart`, `SessionEnd`, `Notification`, `PreCompact` | Cannot block; stderr is shown as a warning. |

### JSON on stdout (the precise way)

If a hook prints a JSON object (output starting with `{`), OrbCode parses it for
fine-grained control. All fields are optional:

```jsonc
{
  "continue": false,                  // stop the whole turn immediately
  "stopReason": "…",                  // message shown when continue is false
  "suppressOutput": true,             // don't surface this hook's stdout
  "systemMessage": "…",               // show a note to the user
  "decision": "approve" | "block",    // approve = skip the approval prompt;
  "reason": "…",                      //   block = deny the action, with this reason
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",    // must match the event
    "permissionDecision": "allow" | "deny" | "ask",
    "permissionDecisionReason": "…",
    "updatedInput": { "command": "ls -la" },  // PreToolUse: rewrite the tool input
    "additionalContext": "…"                  // inject extra context for the model
  }
}
```

Quick guide to the most useful fields:

- **Skip the approval prompt** (auto-allow a tool):
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`
- **Deny a tool with a reason**:
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
- **Force the approval prompt** even for an auto-approved tool:
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"}}`
- **Rewrite the tool input**:
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{…}}}`
- **Inject context** (any of PreToolUse/PostToolUse/UserPromptSubmit/SessionStart):
  `{"hookSpecificOutput":{"hookEventName":"…","additionalContext":"…"}}`
- **Block a prompt or force the agent to continue**:
  `{"decision":"block","reason":"…"}`

Plain (non-JSON) stdout is treated as `additionalContext` for `UserPromptSubmit`
and `SessionStart`, and ignored elsewhere — so `echo "some context"` is the
shortcut for injecting context on those two events.

---

## Events reference

OrbCode fires these events. The **Matcher** column is the field the matcher
regex is tested against (for events with no match field, only an empty/`"*"`
matcher applies).

### `SessionStart`

Fires once, before the first turn of a session (or the first turn after
`--resume`).

- **Matcher:** `source` — `"startup"` or `"resume"`.
- **Extra input:** `source`.
- **Can:** inject session context (stdout on exit 0, or `additionalContext`).
- **Cannot:** block.

Example payload on stdin:

```json
{"session_id":"…","transcript_path":"…","cwd":"…","hook_event_name":"SessionStart","source":"startup"}
```

### `UserPromptSubmit`

Fires before each prompt is sent to the model.

- **Matcher:** none.
- **Extra input:** `prompt` (the text you typed).
- **Can:** inject context (stdout/`additionalContext`), **block** the prompt
  (`exit 2` or `{"decision":"block"}`), or stop the turn (`{"continue":false}`).

### `PreToolUse`

Fires before a tool runs — **before** its approval prompt.

- **Matcher:** `tool_name`.
- **Extra input:** `tool_name`, `tool_input` (the tool's arguments).
- **Can:** **deny** the tool, **allow** it (skip approval), **ask** (force
  approval), **rewrite** `tool_input` via `updatedInput`, or add context.

### `PostToolUse`

Fires right after a tool returns.

- **Matcher:** `tool_name`.
- **Extra input:** `tool_name`, `tool_input`, `tool_response` (the tool's output text).
- **Can:** add context / feedback to the model (`additionalContext`, or
  `{"decision":"block","reason":…}`). The tool has already run — it can't be undone.

### `Notification`

Fires when OrbCode pauses for you — when it needs permission to run a tool, or
when it asks a follow-up question.

- **Matcher:** none.
- **Extra input:** `message` (what OrbCode is asking).
- **Can:** anything with side effects (notify, log). Cannot block.

### `Stop`

Fires when the model is about to finish the turn.

- **Matcher:** none.
- **Extra input:** `stop_hook_active` — `true` if this turn is already
  continuing **because** a Stop hook blocked it (check this to avoid loops).
- **Can:** force the agent to **keep going** (`exit 2` or
  `{"decision":"block","reason":…}`). OrbCode forces **at most one**
  continuation per turn as a safety net.

### `PreCompact`

Fires before `/compact` summarizes the conversation.

- **Matcher:** `trigger` — currently always `"manual"`.
- **Extra input:** `trigger`, `custom_instructions`.
- **Can:** run side effects (e.g. snapshot the transcript). Cannot cancel compaction.

### `SessionEnd`

Fires when the session ends: quitting (Ctrl+D / `/exit`), `/logout`, or the end
of a `-p` (headless) run.

- **Matcher:** `reason` — `"prompt_input_exit"`, `"logout"`, or `"other"`.
- **Extra input:** `reason`.
- **Can:** run cleanup/logging. Capped at 3s on quit so it never wedges exit.

### `SubagentStop` (reserved)

Defined for Claude Code compatibility, but **OrbCode has no subagents yet**, so
this never fires. It's safe to configure; it's a no-op until subagents land.

---

## When multiple hooks match

All matching hooks for an event **run in parallel**, and their results are
merged:

- **Permission decisions** combine most-restrictive-first: **`deny` > `ask` >
  `allow`**. If any hook denies, the action is denied.
- **Context** (`additionalContext` / plain stdout) from every hook is
  **concatenated**.
- **`updatedInput`**: if more than one hook rewrites the input, the **last**
  matching hook wins.
- **`continue:false`** from any hook stops the turn.
- **Block reasons** from multiple hooks are joined together.

---

## Execution model

- Hooks run through your shell; each gets the JSON payload on stdin.
- Each command has its own **timeout** (default 10s) and is force-killed if it
  overruns — a slow or hung hook never wedges the agent. If a hook ignores
  SIGTERM, OrbCode escalates to SIGKILL after a 2s grace.
- A hook that **fails to start**, **errors**, or **times out** is surfaced as a
  **non-blocking** message; it never crashes OrbCode.
- If you interrupt the turn (Esc), in-flight hooks are signalled to abort.
- Hooks are **opt-in**: with no `hooks` block, there is zero added work and zero
  behavior change.

---

## Environment variables

| Variable | Value |
| --- | --- |
| `MATTERAI_PROJECT_DIR` | the workspace directory (same as `cwd` in the payload) |

Hooks inherit a **redacted** copy of your environment: `$PATH`, `$HOME`,
`$LANG`, `$SHELL`, etc. are available, but **credential-like variables are
stripped** so a hook can never exfiltrate your API token. Specifically redacted:

- `MATTERAI_TOKEN`, `MATTERAI_API_KEY`, `MATTERAI_CONFIG_DIR`,
  `MATTERAI_BACKEND_URL`, `MATTERAI_APP_URL` (OrbCode's own vars).
- Any variable whose name matches `/(?:^|_)(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY)(?:$|_)/i`
  (so `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `DATABASE_PASSWORD`, … are
  redacted too).

If a hook genuinely needs a credential, pass it explicitly via the hook's
`command` (e.g. read it from a file the hook can access, or set a dedicated
non-matching env var).

---

## Cookbook (copy-paste recipes)

Each recipe is a `settings.json` snippet plus (where useful) a script. Put
scripts under `~/.orbcode/hooks/` and `chmod +x` them.

### Auto-format files after edits

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "file_edit|file_write|multi_file_edit",
        "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/format.sh" }]
      }
    ]
  }
}
```

`~/.orbcode/hooks/format.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
# file_edit/file_write expose .tool_input.file_path; multi_file_edit uses .edits[].file_path
files=$(printf '%s' "$input" | jq -r '
  [ .tool_input.file_path, (.tool_input.edits[]?.file_path) ]
  | map(select(. != null)) | .[]')
for f in $files; do
  case "$f" in
    *.ts|*.tsx|*.js|*.jsx|*.json) npx --no-install prettier --write "$f" 2>/dev/null ;;
    *.py) black -q "$f" 2>/dev/null ;;
    *.go) gofmt -w "$f" ;;
  esac
done
exit 0
```

### Block edits to protected files

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "file_edit|file_write|multi_file_edit",
        "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/protect.sh" }]
      }
    ]
  }
}
```

`~/.orbcode/hooks/protect.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
files=$(printf '%s' "$input" | jq -r '
  [ .tool_input.file_path, (.tool_input.edits[]?.file_path) ]
  | map(select(. != null)) | .[]')
for f in $files; do
  case "$f" in
    *.env|*/secrets/*|*/.git/*)
      echo "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Refusing to modify protected file: $f\"}}"
      exit 0 ;;
  esac
done
exit 0
```

### Block dangerous shell commands

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "execute_command",
        "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/guard.sh" }]
      }
    ]
  }
}
```

`~/.orbcode/hooks/guard.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
if printf '%s' "$cmd" | grep -Eq 'rm -rf (/|~|\*)|mkfs|dd if=|:\(\)\{'; then
  echo "Blocked dangerous command: $cmd" >&2
  exit 2
fi
exit 0
```

### Auto-approve a safe, read-only tool

Skip the approval prompt for `read_file` and `list_files`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "read_file|list_files|search_files",
        "hooks": [
          { "type": "command",
            "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\"}}'" }
        ]
      }
    ]
  }
}
```

### Always require approval for one tool

Force the prompt for `web_fetch` even in auto-approve mode:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "web_fetch",
        "hooks": [
          { "type": "command",
            "command": "echo '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"ask\"}}'" }
        ]
      }
    ]
  }
}
```

### Rewrite / normalize tool input

Force `ls` to always be `ls -la`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "execute_command",
        "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/rewrite.sh" }]
      }
    ]
  }
}
```

`~/.orbcode/hooks/rewrite.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
if [ "$cmd" = "ls" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"ls -la"}}}'
fi
exit 0
```

### Inject dynamic context on every prompt

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [
        { "type": "command",
          "command": "echo \"Repo: $(basename $MATTERAI_PROJECT_DIR) · branch $(git branch --show-current 2>/dev/null) · $(date '+%H:%M')\"" }
      ] }
    ]
  }
}
```

### Block prompts that look like leaked secrets

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/no-secrets.sh" }] }
    ]
  }
}
```

`~/.orbcode/hooks/no-secrets.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
prompt=$(printf '%s' "$input" | jq -r '.prompt')
if printf '%s' "$prompt" | grep -Eq 'AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----'; then
  echo '{"decision":"block","reason":"That prompt appears to contain a credential — not sending it."}'
fi
exit 0
```

### Load team conventions at session start

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "cat ~/.orbcode/team-conventions.md 2>/dev/null || true" }] }
    ]
  }
}
```

### Desktop notification when OrbCode needs you (macOS)

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/notify.sh" }] }
    ]
  }
}
```

`~/.orbcode/hooks/notify.sh`:

```bash
#!/usr/bin/env bash
msg=$(cat | jq -r '.message // "OrbCode needs your attention"')
osascript -e "display notification \"$msg\" with title \"OrbCode\""
exit 0
```

### Keep working until tests pass

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/tests-must-pass.sh" }] }
    ]
  }
}
```

`~/.orbcode/hooks/tests-must-pass.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
# Never loop forever: if we already forced a continuation, let it stop.
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active')" = "true" ] && exit 0
if ! npm test --silent >/dev/null 2>&1; then
  echo '{"decision":"block","reason":"Tests are still failing — fix them before finishing."}'
fi
exit 0
```

### Snapshot the transcript before compaction

```json
{
  "hooks": {
    "PreCompact": [
      { "hooks": [{ "type": "command", "command": "~/.orbcode/hooks/snapshot.sh" }] }
    ]
  }
}
```

`~/.orbcode/hooks/snapshot.sh`:

```bash
#!/usr/bin/env bash
input=$(cat)
src=$(printf '%s' "$input" | jq -r '.transcript_path')
mkdir -p ~/.orbcode/snapshots
cp "$src" ~/.orbcode/snapshots/"$(date +%s).json" 2>/dev/null || true
exit 0
```

### Log every session end

```json
{
  "hooks": {
    "SessionEnd": [
      { "hooks": [{ "type": "command",
        "command": "input=$(cat); echo \"$(date) ended: $(printf '%s' \"$input\" | jq -r .reason)\" >> ~/.orbcode/session.log" }] }
    ]
  }
}
```

---

## Debugging hooks

**Run a hook by hand** — pipe it a fake payload and inspect the exit code:

```bash
echo '{"hook_event_name":"PreToolUse","tool_name":"execute_command","tool_input":{"command":"rm -rf /"}}' \
  | ~/.orbcode/hooks/guard.sh
echo "exit=$?"
```

**No `jq`?** Parse with Python or Node:

```bash
file=$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("tool_input",{}).get("file_path",""))')
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log((JSON.parse(s).tool_input||{}).file_path||""))')
```

**Common pitfalls**

- **Forgetting `exit 0`** at the end of a script — a leftover non-zero exit from
  the last command will be read as an error (or a block, if it's 2).
- **Reading stdin twice** — `cat` drains it. Read once into a variable
  (`input=$(cat)`), then reuse.
- **Output that accidentally starts with `{`** — it'll be parsed as a JSON
  control object. Prefix plain text (e.g. `echo "note: …"`) if that's not what
  you want.
- **Relative script paths** — use an absolute path or `~`; OrbCode runs the hook
  with the workspace as the working directory.
- **`matcher` on a no-match-field event** (e.g. a `matcher` on `Stop`) — it will
  never match. Omit the matcher for those events.
- **Wrong tool names** — OrbCode uses `execute_command`, `file_edit`,
  `file_write`, `multi_file_edit`, `read_file`, `list_files`, `search_files`,
  `web_fetch`, `web_search`, `update_todo_list` (not Claude Code's `Bash`,
  `Edit`, `Write`, …).

A hook's full stdout/stderr is surfaced to you when it produces a
`systemMessage` or a non-blocking error, so you can see what went wrong.

---

## Differences from Claude Code

The **contract is identical** (stdin JSON, exit-code protocol, JSON output
schema, matcher regexes, parallel execution, per-command timeout). Differences:

| Topic | Claude Code | OrbCode |
| --- | --- | --- |
| Settings file | `~/.claude/settings.json` | `~/.orbcode/settings.json` |
| Project file | `.claude/settings.json` | `.orbcode/settings.json` |
| Project dir env var | `$CLAUDE_PROJECT_DIR` | `$MATTERAI_PROJECT_DIR` |
| Tool names in matchers | `Bash`, `Edit`, `Write`, `Read`, … | `execute_command`, `file_edit`, `file_write`, `read_file`, … |
| Hook types | `command`, plus newer MCP/HTTP/prompt hooks | `command` only |
| Events | full internal SDK set | the documented set: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`, `PreCompact`, `SessionEnd` (+ `SubagentStop`, reserved) |

Events present in newer Claude Code builds but **not** in OrbCode yet:
`PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Setup`,
`SubagentStart`, `PostCompact`, and the worktree/file-watch/elicitation events.
Ask if you want any of these wired up.

---

## Security

Hooks execute **arbitrary shell commands as your user**. OrbCode treats the two
sources of hooks differently:

- **User hooks** (`~/.orbcode/settings.json`) are written by you and always run.
- **Project hooks** (`<repo>/.orbcode/settings.json`) ship inside a repository
  and could come from anyone, so they are **disabled until you trust them**.

### The trust prompt

The first time OrbCode starts in a project that defines hooks, it lists the
shell commands those hooks would run and asks whether to trust them:

- **Trust & enable** → the project's hooks run for this workspace, and the
  decision is saved to `~/.orbcode/hook-trust.json`.
- **Keep disabled** → the project's hooks never run; only your user hooks do.

Trust is bound to the **exact hook configuration** (a content hash). If the
project's hooks change later, OrbCode asks again — a repo can't get a blank
cheque and then quietly swap in a different command.

In **non-interactive** (`-p`) mode there is no prompt, so untrusted project
hooks are **skipped** with a warning on stderr. Set
`MATTERAI_TRUST_PROJECT_HOOKS=1` to trust project hooks in CI/automation where
you control the repository. **This env var is only honored when stdin is not a
TTY** — a stray `export` in a shell rc file cannot silently disable the trust
gate for interactive sessions.

> Even with the gate: **review `.orbcode/settings.json` before trusting** a
> repository's hooks — trusting them runs their commands on your machine.

### Other notes

- **Hooks see a redacted environment** — they inherit `$PATH`, `$HOME`, etc.
  but **never** your API token or other credential-like variables (see
  [Environment variables](#environment-variables)). Treat hook scripts like
  any other code you run locally, but OrbCode ensures they can't silently
  exfiltrate your OrbCode credentials.
- **Injected context is sandboxed** — text a hook injects via
  `additionalContext` (or plain stdout on `UserPromptSubmit`/`SessionStart`)
  is wrapped in `<hook_context>` tags and capped at ~8 KB. The system prompt
  tells the model to treat the contents as untrusted, so a hook can't
  prompt-inject the model into running arbitrary commands.
- **Tool-input rewrites are logged** — when a `PreToolUse` hook rewrites a
  tool's input via `updatedInput`, OrbCode emits a visible system message so
  you can see that a hook changed what the model asked for.
- Keep hook commands small and auditable; prefer checked-in scripts over long
  inline commands.
