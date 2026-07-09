# Task: sync-smoke script (Slice A2)

You are in a worktree of a t3code fork with a full LHC integration (capture + compact/
prune swap for Claude and Codex — read `docs/lhc/operations.md` first). Build the ONE
COMMAND that certifies a freshly merged/deployed build: boots a scratch server, runs
real provider turns, verifies capture, runs a compact and a prune, verifies resume, and
tears down. Exit 0 = certified, exit 1 = broken, with a report file either way. This
script becomes the acceptance gate for every future upstream sync, so determinism and
honest failure reporting matter more than breadth.

## Reuse — do not reinvent

- `packages/lhc-host/probes/ws-driver.ts` / `ws-scenario.ts` (WS auth + turn driving),
  `verify-lhc.ts` (record checks), `phase2-acceptance.ts` / `phase4-acceptance.ts`
  (the flows you are distilling — steal their working code freely).
- Boot recipe incl. resolve hook: `docs/lhc/operations.md`. The web dist is NOT needed
  (no browser) — do not build it.

## The script: `packages/lhc-host/smoke/sync-smoke.ts`

Runnable as: `node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs packages/lhc-host/smoke/sync-smoke.ts [--skip-codex] [--skip-claude] [--keep]`

1. **Setup**: fresh temp base dir + fresh temp `T3CODE_LHC_HOME` (never the real ones,
   never the dogfood dirs), pick a free port (bind port 0 or probe a range — do NOT
   hardcode 4601, a dogfood server may be running there). Fresh temp git repo as cwd.
2. **Boot + identity check**: spawn the server, wait for `userdata/server-runtime.json`,
   then verify THE SERVER WE SPAWNED is serving: pid in runtime.json is our child's pid
   and `startedAt` is after our spawn time (lesson from a real incident: a stale server
   on the same port once answered 200 and masqueraded as the new build). Mint auth via
   the ws-scenario auth flow.
3. **Per provider (Claude via haiku, Codex via gpt-5.4-mini + low reasoning — cheapest;
   skip flags respected)**:
   a. Start thread, seed a codename fact, run 2 small turns (one with a modest `seq
   2000`-style tool output).
   b. Capture check: lineage row exists, `user_prompt` count == turns sent (no doubles),
   tool_result present with full (non-preview) output, turns close.
   c. Swap: compact for Claude, prune for Codex (covers both ops across both providers'
   strategies). Verify receipt 200, cursor flipped to the receipt's new session id,
   rebuilt file exists at rebuiltPath.
   d. Resume: one recall turn ("what was the codename?") — PASS requires the correct
   codename AND evidence the session used the rebuilt id.
   e. `/lhc/status` shows the thread; derivations not failed/blocked (ready or pending
   is fine — do NOT wait for full drain; cap any wait at 60s).
4. **Teardown**: kill the spawned server (SIGTERM, then SIGKILL after 10s), remove temp
   dirs unless `--keep`. Teardown runs on EVERY path (failure, exception, Ctrl-C).
5. **Report**: `docs/lhc/sync-reports/<YYYY-MM-DD-HHmm>.md` — PASS/FAIL table per item,
   timings, cost estimate, and on failure: the failing step's evidence (response body,
   relevant server-log tail). Also print the table to stdout. Exit code reflects overall.
6. **Budget honesty**: total paid turns ≤8; hard-fail with a clear message if a turn
   hangs >120s rather than burning retries.

## Also

- `docs/lhc/operations.md`: new "Sync smoke" section (when to run it, the command, how
  to read a report, the skip flags).
- Hermetic unit tests only where cheap (port-picking, report formatting, identity-check
  logic as pure functions). The script's real verification is a live run — the
  orchestrator does that; you must NOT run the live script yourself (no paid calls, and
  a dogfood server is running on this machine — your port-picking must avoid it).

## Gates

`vp run typecheck` + `vp check` green; lhc-host tests green. No `git commit`.

## Report back

Script structure, how identity-check + port-picking work, what you stole from which
probe, test results, the exact command for the orchestrator's live run.
