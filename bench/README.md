# Harness benchmark

Measures how the agent loop behaves on small, verifiable coding tasks so harness
changes (system prompt, tool schemas, edit tool, context handling) can be judged
on data instead of feel.

```sh
# baseline vs. a change: run each arm at least 3 times, ideally in parallel
node --import tsx bench/run.ts --model zai/glm-5.3 --label before --reps 3
node --import tsx bench/run.ts --model zai/glm-5.3 --label after  --reps 3
node --import tsx bench/compare.ts bench/results/before-*.json bench/results/after-*.json
```

Flags: `--suite core|extended|all` (default `core`), `--tasks a,b`, `--steps`
(print each step's tools / input tokens), `--variant <name>` (system-prompt
override from `variants.ts`, for A/B tests before touching `src/`).

## What it does

- Every run gets a fresh throwaway git repo (`fixture.ts`) and the real `Agent`
  loop with auto-approve on. `HOME` and the config dir are redirected to a temp
  dir, so your sessions, `AGENTS.md` and skills never leak in; the login token is
  read first and passed explicitly. Unknown model ids are rejected (they would
  otherwise fall back to the default silently).
- Success is decided by tests the agent never saw (`tasks.ts`), plus checks such
  as "test files untouched" or "CRLF and tabs preserved".
- Results are saved to `bench/results/` (git-ignored). Real model calls cost
  money: the core suite is about $0.01 per run on `glm-5.3-flash` and about
  $0.08 on `glm-5.3`.

## Suites

| suite | tasks |
|---|---|
| `core` | fix-bugs, rename, add-method, question, trivial-edit, multi-file-feature |
| `extended` | legacy-edit (CRLF + tabs), big-repo-bug (40 generated modules), long-feature (5-part change across layers) |

## Reading the numbers

- Wall time is dominated by the gateway (time to first token) and is very noisy:
  the same task has taken 13s and 41s with identical code, and single steps have
  stalled for minutes. Compare **medians over several reps**, and lean on
  step count, input tokens and reasoning time, which are steadier.
- Runs that hit a gateway stall (`ECONNRESET`, the 10 minute timeout) fail for
  reasons unrelated to the harness; check `detail` / `timedOut` before treating a
  FAIL as a regression.
- Context pruning and auto-compaction only trigger at 40% / 80% of the model's
  window (about 93k / 186k tokens), which these tasks do not reach; they are
  covered by unit tests in `test/agent-context.test.ts` instead.
