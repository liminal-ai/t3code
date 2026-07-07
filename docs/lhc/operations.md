# LHC operations guide

Operator-facing runbook for the t3code LHC fork (Phase 2 complete as of Slice 2.4).
Written for running on a fresh box — nothing here is aspirational.

## State layout

Default home: `~/.t3code-lhc/` (override with `T3CODE_LHC_HOME`). **Never** use `~/.lhc`.

| Path                                     | Purpose                               |
| ---------------------------------------- | ------------------------------------- |
| `$T3CODE_LHC_HOME/registry.sqlite`       | LHC thread registry                   |
| `$T3CODE_LHC_HOME/t3code-lhc.sqlite`     | t3 thread id ↔ LHC thread id lineage  |
| `$T3CODE_LHC_HOME/threads/<uuid>.sqlite` | Per-thread capture + derivation state |

Claude rollouts (swap targets) live under the operator's real `~/.claude/projects/<encoded-cwd>/`
— LHC does not relocate them.

## Environment flags

| Variable                          | Default         | Effect                                                                                                                                                                                                       |
| --------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `T3CODE_LHC_HOME`                 | `~/.t3code-lhc` | Scratch/state root. Set to an isolated path for validation runs.                                                                                                                                             |
| `T3CODE_LHC_DISABLE`              | unset           | `=1` → entire capture service is a no-op: no SDK, no state dirs, no event handling.                                                                                                                          |
| `T3CODE_LHC_NO_INFERENCE`         | unset           | `=1` → capture records events but SDK runs in manual mode with deterministic callbacks (no `claude -p` calls); shutdown skips drain-settle waits.                                                            |
| `T3CODE_LHC_SUPPRESS_AUTOCOMPACT` | on (implicit)   | When capture is active, Claude sessions get `settings.autoCompactEnabled: false` so native auto-compact does not race LHC compaction. Set `0` or `false` to opt out. Forced off when `T3CODE_LHC_DISABLE=1`. |
| `T3CODE_LHC_CLAUDE_BIN`           | `claude`        | Executable used for inference-lane `claude -p` subprocesses (`packages/lhc-host/src/shared/claude-bin.ts`). Set to an absolute path when `claude` is not on `PATH`.                                          |

Optional inference tuning (see troubleshooting):

| Variable                           | Default | Effect                                                                  |
| ---------------------------------- | ------- | ----------------------------------------------------------------------- |
| `T3CODE_LHC_INFERENCE_CONCURRENCY` | `8`     | Host cap on concurrent `claude -p` subprocesses for the inference lane. |
| `T3CODE_LHC_INFERENCE_TIMEOUT_MS`  | `60000` | Per-call timeout for inference subprocesses.                            |

## Server boot recipe

Run from the repo root. Use a scratch LHC home and t3 base dir — do not touch production
`~/.t3code-lhc` during validation.

```sh
export T3CODE_LHC_HOME=$HOME/code/t3code-lhc/validation/lhc-home
export BASE=$HOME/code/t3code-lhc/validation/t3home

# 1. Boot (suppression defaults ON; only gate is T3CODE_LHC_DISABLE)
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts serve --port 4601 --base-dir "$BASE" --host 127.0.0.1
# -> writes $BASE/userdata/server-runtime.json {origin, port, pid, …}

# 2. Mint a reusable bearer (orchestration:read + orchestration:operate)
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  packages/lhc-host/probes/ws-scenario.ts auth --base-dir "$BASE" --out "$BASE/driver-auth.json"

# 3. Export token for curl
TOK=$(node -e "console.log(require('$BASE/driver-auth.json').accessToken)")
```

The resolve hook is required because plain `node` / `vp pack` do not resolve this monorepo's
TypeScript imports. See `docs/lhc/findings/live-capture-validation.md` for WS auth details:
the browser OAuth path returns 401 for CLI clients; use the in-process bearer + ws ticket flow
in `ws-scenario.ts auth`.

Drive turns over WebSocket with `packages/lhc-host/probes/ws-scenario.ts run` or the
`ws-driver.ts` library. Persisted Claude resume cursor:

```sh
sqlite3 -json "$BASE/userdata/state.sqlite" \
  "SELECT thread_id, resume_cursor_json FROM provider_session_runtime;"
```

## HTTP curl book

All `/lhc` routes use the same bearer as other raw orchestration routes (`Authorization: Bearer $TOK`).

### `GET /lhc/status`

```sh
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:4601/lhc/status | jq .
```

Example (abbreviated):

```json
{
  "ok": true,
  "value": {
    "capture": {
      "enabled": true,
      "mode": "background",
      "eventsSeen": 438,
      "eventsIgnored": 0,
      "global": { "pendingHigh": 5, "mapper": { "…": "…" }, "intake": { "…": "…" } },
      "threads": [{ "t3ThreadId": "…", "pending": 0, "pendingHigh": 3, "…": "…" }]
    },
    "threads": [
      {
        "t3ThreadId": "8cc680c7…",
        "lhcThreadId": "th_9bfdfb618f70d7de",
        "providerKind": "claudeAgent",
        "eventCount": 44,
        "turnCount": 8,
        "lastActivityAt": "2026-07-07T…",
        "pending": 0,
        "pendingHigh": 3
      }
    ]
  }
}
```

`capture.global.pendingHigh` is the peak intake-queue depth across all threads (including
threads whose in-memory state was later evicted).

Per-thread `pending` / `pendingHigh` reflect **hot in-memory capture state only** (the
intake queue for threads currently loaded in the capture service). `GET /lhc/status`
lists **all** lineage rows under `value.threads[]`; for threads that are not currently
hot — idle-evicted from memory or not yet touched since restart — those fields fall back
to `0`. `value.capture.threads[]` contains **only** currently-hot threads (same source
as the non-zero pending values when present).

### `GET /lhc/threads/:t3ThreadId`

```sh
curl -s -H "Authorization: Bearer $TOK" \
  http://127.0.0.1:4601/lhc/threads/<t3ThreadId> | jq .
```

Example fields that matter for compaction decisions:

```json
{
  "ok": true,
  "value": {
    "t3ThreadId": "8cc680c7…",
    "lhcThreadId": "th_9bfdfb618f70d7de",
    "overview": { "events": { "count": 44 }, "turns": { "open": 1, "closed": 7 }, "…": "…" },
    "health": { "failures": [], "queue": { "queued": 0, "claimed": 0 }, "…": "…" },
    "viewStatus": {
      "tailTokens": 940055,
      "threshold": 160000,
      "compactRecommended": true,
      "derivation": { "pending": 0, "retrying": 0, "failed": 0, "blocked": 0 },
      "visibility": { "boundaryPosition": 0, "zoneTokens": 0, "maxTokens": 200000 }
    },
    "tailTokens": 940055,
    "compactRecommended": true
  }
}
```

Use **LHC `tailTokens` / `compactRecommended`**, not the provider's `usedTokens`, to
decide when to compact. The provider counter is baseline-dominated (~26k Claude Code
system+tools) and does not reflect full captured tool output (see Phase 2 acceptance).

### `POST /lhc/threads/:t3ThreadId/compact`

```sh
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4601/lhc/threads/<t3ThreadId>/compact | jq .
```

Success → **200**, `ok: true`, receipt with `oldSessionId`, `newSessionId`, `rebuiltPath`,
`rebuilt`, `cursor`, `timings`, `runtimeNote`. `stepReached` is absent on success.

Optional body: `{ "profile": "…", "params": { … } }` (LHC compact profile knobs).

### `POST /lhc/threads/:t3ThreadId/prune`

```sh
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4601/lhc/threads/<t3ThreadId>/prune | jq .
```

Optional body: `{ "targetTokens": 20000 }`.

### Error responses

Swap and inspect errors: `{ "ok": false, "error": { "code", "message", "stepReached?", "retriable?", "detail?" } }`.
Other LHC HTTP errors omit `stepReached` / `retriable`.

| HTTP | `code`                                                                                      | `stepReached` (typical) | `retriable` | Meaning                                                                                                                                  |
| ---- | ------------------------------------------------------------------------------------------- | ----------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 404  | `not_captured`                                                                              | `resolve-lineage`       | false       | t3 thread has no LHC lineage row.                                                                                                        |
| 404  | `not_found`                                                                                 | —                       | —           | Unknown `/lhc` path.                                                                                                                     |
| 405  | `method_not_allowed`                                                                        | —                       | —           | Wrong HTTP method for the route (e.g. POST on `GET /lhc/status`).                                                                        |
| 409  | `busy`                                                                                      | `busy-check`            | true        | Provider turn in flight (`activeTurnId` set). Wait and retry.                                                                            |
| 409  | `swap_in_progress`                                                                          | `busy-check`            | true        | Another compact/prune is running for this thread.                                                                                        |
| 409  | `flip_contested`                                                                            | `cursor-flip`           | true        | Provider restarted between quiesce and cursor flip; cursor was **not** updated. Retry when idle. Detail names the observed session/turn. |
| 409  | `missing_provider_binding`                                                                  | `read-binding`          | false       | No provider runtime binding for the thread.                                                                                              |
| 503  | `capture_disabled`                                                                          | `resolve-lineage`       | false       | `T3CODE_LHC_DISABLE=1` or capture not initialized.                                                                                       |
| 500  | `not_claude`                                                                                | `read-binding`          | false       | Thread is bound to a non-Claude provider; compact/prune are Claude-only.                                                                 |
| 500  | `internal_error`                                                                            | —                       | —           | Unhandled exception in the HTTP handler (non-`ClaudeSwapError`).                                                                         |
| 500  | `swap_failed`, `lhc_operation_failed`, `missing_source_rollout`, `invalid_resume_cursor`, … | last step reached       | varies      | Hard failure; see `stepReached` and `detail`.                                                                                            |

**`flip_contested` semantics:** the swap aborted before reporting success. The persisted
cursor still names the pre-swap Claude session. Never treat a contested response as a
completed swap.

## Troubleshooting

### Silent-swap tells (watch after every compact/prune)

1. **`missing_source_rollout`** (500, `stepReached: resolve-paths`) — could not find
   `~/.claude/projects/.../<oldSessionId>.jsonl`. Check cwd encoding and that the session
   had a real rollout before swap.
2. **First turn after swap: "No conversation found with session ID: …"** — resume uuid has
   no rollout file (or file was removed). Detected at first `sendTurn`, not at compact time.
   Pre-validate `rebuiltPath` exists and `cursor.resume` matches the rebuilt file's
   `sessionId`.

Do **not** send turns while a swap is in flight.

### Busy / locked handling

- **`busy` (409):** wait for the in-flight turn to finish (`activeTurnId` clears), then retry.
- **`swap_in_progress` (409):** wait for the in-flight swap (<200 ms typical), then retry.
- **`flip_contested` (409):** stop the provider session if needed, confirm idle, retry compact.

### Derivations not draining

Check `GET /lhc/threads/:id` → `health` and `viewStatus.derivation`:

- **`pending` / `retrying` stuck:** inference lane may be blocked. Confirm `T3CODE_LHC_NO_INFERENCE` is **not** set (unless intentional). Confirm `claude` CLI is on `PATH` and authenticated (`claude -p` works), or set `T3CODE_LHC_CLAUDE_BIN` to the absolute path of the executable.
- **Concurrency:** default host cap is **8** concurrent `claude -p` subprocesses (`T3CODE_LHC_INFERENCE_CONCURRENCY`). Many active threads can queue behind this cap — normal, but watch `capture.global.pendingHigh` and per-thread `pending` on hot threads (see status endpoint note — evicted threads show `0`).
- **Model:** inference assignments pass the CLI model string `sonnet` (`claude -p --model sonnet` via `ccAssignments`), not the operator's chat model.
- **Failures:** `health.failures` and `derivation.failed` / `blocked` — inspect LHC log (below) and server stderr.

Shutdown waits up to 30 s for derivations to drain (`DEFAULT_DRAIN_SETTLED_CAP_MS`).

### Kill switches

| Goal                             | Setting                                                                                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Disable all LHC                  | `T3CODE_LHC_DISABLE=1` — no state dirs created, no capture.                                                                                                                |
| Capture without paid inference   | `T3CODE_LHC_NO_INFERENCE=1` — deterministic derivations, fast shutdown.                                                                                                    |
| Allow Claude native auto-compact | `T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0` — only matters when context nears the native trigger; redundant if `~/.claude/settings.json` already sets `autoCompactEnabled: false`. |

### Logs

| Log                    | Where                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **LHC per-thread log** | Inside each `threads/<uuid>.sqlite` via SDK `logging.query` (or `packages/lhc-host/probes/verify-lhc.ts`). Warnings include intake backlog >10k. |
| **Server log**         | stderr from the `serve` process. LHC capture warnings use `t3code-lhc:` prefix.                                                                  |
| **Capture service**    | `capture.stats()` surfaces `eventsSeen`, `eventsIgnored`, per-thread `pending`/`pendingHigh`.                                                    |

Sanity probe:

```sh
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  packages/lhc-host/probes/verify-lhc.ts --home "$T3CODE_LHC_HOME" --t3-thread <t3ThreadId>
```

## Known limits

| Limit                                    | Notes                                                                                                                                                                                                                                                             |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Window A — interrupted turn loss**     | A turn that races after the busy check can be interrupted by quiesce. Content stays in the LHC record but drops from the resumed Claude rollout. Accepted v1. See `swap/claude.ts` header comment.                                                                |
| **Contested-flip detection is post-hoc** | `flip_contested` is detected at cursor-flip time (pre-flip active session or stale cursor after write), not proactively blocked for all races.                                                                                                                    |
| **Per-thread swap lock only**            | Lock serializes compact/prune per t3 thread; does not block `sendTurn` on other code paths.                                                                                                                                                                       |
| **Suppression vs user settings**         | `T3CODE_LHC_SUPPRESS_AUTOCOMPACT` sets SDK `autoCompactEnabled: false` per session. If the box's `~/.claude/settings.json` already disables auto-compact, live differential is unobservable — unit tests still verify the adapter path (`ClaudeAdapter.test.ts`). |
| **t3 UI rollback/fork**                  | Not LHC-aware. Rolling back in the t3 UI diverges the LHC record from provider state; tolerated (runtime-note scar at most). See `docs/lhc/implementation-plan.md`.                                                                                               |
| **Provider `usedTokens` ≠ LHC fidelity** | Do not use provider context-window counters as a compaction trigger. Use LHC `tailTokens` / `compactRecommended`. See `docs/lhc/findings/phase2-acceptance.md`.                                                                                                   |

## Reusable probes

Under `packages/lhc-host/probes/`:

- `ws-scenario.ts` — auth + drive turns
- `verify-lhc.ts` — read-side SDK inspection
- `phase2-acceptance.ts` — full compact/prune acceptance flow
- `ts-js-resolve-hook.mjs` — required for `node --import` boots
