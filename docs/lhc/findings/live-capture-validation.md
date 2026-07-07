# LHC live-capture validation (Slice 1.3 — Phase 1 milestone gate)

Proves the full LHC capture path against the **real** server driven over the
**real** WebSocket API with **real** Claude and Codex provider sessions. Every
checklist item was exercised end-to-end (boot server → drive turns over `/ws` →
read the LHC sqlite via the `lhc` SDK).

- **Date:** 2026-07-07
- **Scratch capture home:** `~/code/t3code-lhc/validation/lhc-home` (+ `-disable`,
  `-noinf` for the kill-switch boots). The real `~/.t3code-lhc` was never touched.
- **Server base dir:** `~/code/t3code-lhc/validation/t3home`, **port 4599**, host `127.0.0.1`.
- **Provider sessions:** fresh temp git repos under `~/code/t3code-lhc/validation/repos/*`.
- **No `git commit` was made.** New files: the four probes below + this doc.

## Result summary

| #   | Item                                               | Result   | Headline evidence                                                                                                                                                                                                   |
| --- | -------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Claude multi-turn (reasoning, `seq 1 20000`, edit) | **PASS** | lineage row; overview turns open:1/closed:3; `user_prompt`×3, `assistant_thinking`×3, `assistant_text`×3, tool_call/tool_result×2; **full seq tool_result = 108,927 bytes** (list == show); derivations 14/14 ready |
| 2   | Codex multi-turn (`seq`, edit, small)              | **PASS** | `user_prompt`×3 (one per turn, **no dedup doubles**); full aggregatedOutput 108,938 bytes; turns open:1/closed:3; derivations 15/15 ready                                                                           |
| 3   | Interrupt (slow turn → API interrupt → next turn)  | **PASS** | `runtime_note`×1 captured; interrupted turn + next turn both closed (open:1/closed:2); next turn `ready`                                                                                                            |
| 4   | Derivations drain (inference ON, real `claude -p`) | **PASS** | smoothed_prompt + all turn derivations `ready`, queue {0,0}, 0 failed/blocked; **drain latency ~2–3 s** small turn                                                                                                  |
| 5   | Mid-session restart / resume                       | **PASS** | resume resolves to **same** LHC thread; events 4→8 (**exactly +4, no replay dups**); one open turn holds                                                                                                            |
| 6   | Stats / logging sanity                             | **PASS** | LHC log total 0 / 0 warnings on every thread; no LHC warnings in server logs; `stats()` has no endpoint (sqlite-via-inspect is the reachable path)                                                                  |
| 7   | Kill switches (`DISABLE`, `NO_INFERENCE`)          | **PASS** | `DISABLE=1` → lhc-home **never created**; `NO_INFERENCE=1` → capture recorded, **0 inference children** (control caught `claude -p --model sonnet`)                                                                 |

All seven items PASS. No blocking failures.

---

## Server boot + WS auth recipe (reusable)

### 1. Boot the server headlessly from source

The least-magic path is running the TypeScript entrypoint directly with a tiny
resolve hook (see the "resolve-hook" finding below for why the hook is needed and
why `vp pack` / plain `node` do not work here):

```sh
export T3CODE_LHC_HOME=/path/to/scratch/lhc-home          # NEVER ~/.t3code-lhc
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts serve \
  --port 4599 --base-dir /path/to/scratch/t3home --host 127.0.0.1
```

`serve` prints `Listening on http://127.0.0.1:4599`, a one-time `Token:` (startup
pairing credential), and writes `<base-dir>/userdata/server-runtime.json`
(`{origin, port, pid, …}`) — the authoritative way to discover the live origin/pid.
LHC capture is wired unconditionally (`makeLhcCaptureLayer` in `apps/server/src/server.ts`);
the only gate is `T3CODE_LHC_DISABLE`.

### 2. Authenticate a non-browser WebSocket client

The browser `/oauth/token` startup-credential exchange returns **401
`invalid_credential`** for a CLI (that path is browser/pairing-oriented). The
headless path — matching `t3 connect` — mints a **bearer session in-process**
against the server's on-disk signing secret + session store (shared via
`--base-dir`), then exchanges it for a short-lived WebSocket **ticket**:

```sh
# (a) bearer — signed with the shared secret, session row lands in shared sqlite
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts auth session issue --token-only --base-dir /path/to/scratch/t3home
# (b) POST /api/auth/websocket-ticket  (Authorization: Bearer <bearer>)  -> {ticket}
# (c) connect ws://127.0.0.1:4599/ws?wsTicket=<ticket>
```

The ticket rides the query string because the global `WebSocket` used by the RPC
socket cannot attach an `Authorization` header (`authenticateWebSocketUpgrade`
verifies `?wsTicket=` via `verifyWebSocketToken`; the header path is the fallback).
The bearer **survives a server restart** (secret + session row persist on disk),
so `driver-auth.json` can be reused across boots; only the ws ticket is re-minted
per connection. The scenario CLI's `auth` command wraps steps (a)–(b).

### 3. Drive the session over `/ws`

Provider sessions are driven with `orchestration.dispatchCommand`
(`project.create` → `thread.create` → `thread.turn.start` / `thread.turn.interrupt`
/ `thread.session.stop`) and turn lifecycle is followed via
`orchestration.subscribeThread` pushes (turn opens when `session.activeTurnId`
goes non-null + status busy; settles when it clears and status leaves
running/starting).

---

## Reusable probes (Slice 2.x)

All under `packages/lhc-host/probes/` (outside `src/`, so not in package
typecheck/test globs):

- **`ws-driver.ts`** — library: `resolveRuntimeState`, `mintWsTicket`,
  `connectDriver` (typed RPC client over `/ws`, reuses `client-runtime`'s
  `makeWsRpcProtocolClient`), `startThreadMonitor` (subscribeThread → turn
  lifecycle), `createProjectAndThread`, `runTurn`, `stopSession`.
- **`ws-scenario.ts`** — CLI: `auth` (mint + cache bearer), `run` (drive a thread
  through named turn presets; supports `--thread-id`/`--project-id` for the resume
  path and `--keep-open`). Turn presets: `reasoning`, `seq`, `edit`, `slow`
  (interrupt), `hi`, `small`.
- **`verify-lhc.ts`** — read-side verifier using the `lhc` SDK against the scratch
  home: lineage (`t3code-lhc.sqlite`), `inspect.overview`, `inspect.health`,
  `messages.list` + `messages.show`, `logging.query`; reports byKind counts, open/closed
  turns, derivation states, tool_result byte lengths, prompt duplication, and log warnings.
- **`ts-js-resolve-hook.mjs`** — boot-time ESM resolve hook (see finding below).

Model selection: Claude → `claude-haiku-4-5` (cheapest; `thinking` option for the
reasoning turn); Codex → `gpt-5.4`.

---

## Per-item evidence

### 1. Claude multi-turn — PASS

t3 `d979d502…` → LHC `th_502c77595d259b13` (`claudeAgent`). `inspect.overview`:
16 events, 13 visible messages, **turns open:1 / closed:3** (exactly one open
turn). `byKind`: `user_prompt` 3 (host-side injection at the sendTurn choke point
worked — all three prompts present, once each), `assistant_thinking` 3 (reasoning
captured), `assistant_text` 3, `tool_call` 2, `tool_result` 2. The `seq 1 20000`
tool_result carries the **full** output — **108,927 bytes** (`1\n2\n…\n20000\n[tool
outcome: status=completed]`), not a preview; `messages.show` returns the identical
108,927 bytes (`matchesList: true`). Derivations 14/14 ready. LHC log: 0 warnings.

### 2. Codex multi-turn — PASS

t3 `f88e97fe…` → LHC `th_1cfd5f615d16e560` (`codex`). 18 events, 15 messages,
turns open:1 / closed:3. `user_prompt` **exactly 3** — one per turn, **no doubles**
despite Codex's stream `user_message` (deduped against host injection). Full
aggregatedOutput in the `seq` tool_result: **108,938 bytes** (Codex framing
`[tool outcome: exitCode=0 status=completed]`). `assistant_text` 6 (Codex emits
several text blocks/turn). Derivations 15/15 ready, 0 failed. 0 warnings.

### 3. Interrupt — PASS

Slow turn (`for i in $(seq 1 120); …; sleep 1; done`) interrupted via
`thread.turn.interrupt` ~6 s in. LHC record (t3 `66487c20…` → `th_a4d4a9308b87887d`):
`runtime_note` ×1 (the interrupt note) landed, the interrupted turn closed, and the
subsequent small turn also closed — **turns open:1 / closed:2** (turn_end events
present: 10 events vs 8 messages). The next turn returned `ready` (`assistant_text`
for "ok"). Derivations 9/9 ready, 0 warnings.

### 4. Derivations drain — PASS

Inference ON (default config, real `claude -p`). After quiesce, `inspect.health`
on both the Claude and Codex threads shows every owner fully `ready`:
`messages:smoothed_prompt`, `messages:tool_result_summary`,
`turns:detailed_turn_compression`, `turns:pre_detailed_assembly`,
`turns:turn_rendering` — counts equal to (prompts / tool results / closed turns),
`queue {queued:0, claimed:0}`, 0 failed / 0 blocked / 0 failures. **Drain latency**
(measured on a small Claude turn): 3 pending at +0.3 s → all `ready` by **+2.4 s**;
larger turns (tool_result_summary over the 108 KB seq output) drain within ~8 s.
No stuck queue, no pileup.

### 5. Mid-session restart / resume — PASS

Turn 1 on a fresh thread (t3 `3bde47bf…` → `th_185a8db9302240ff`): baseline
**events 4**, turns open:1/closed:1. Server killed with **SIGTERM** (exited clean,
code 0). On a quiesced shutdown **no drain line is logged** — `DRAIN_NOT_SETTLED_MESSAGE`
only fires on the cap-timeout path, so a settled drain is silent (the capture
service's `log`/`logError` are not wired to the server logger). Server restarted on
the same base-dir + LHC home + port. Resume turn dispatched to the **same t3
thread**: lineage resolved to the **same** LHC thread `th_185a8db9302240ff`; events
**4 → 8** — exactly +4 for the new turn (`user_prompt`, `assistant_thinking`,
`assistant_text`, turn*end), **no duplicate events from replay** (idempotent
intake); turns open:1 / closed:2 (one open turn still holds); 0 warnings.
\_Note:* the verifier's `duplicatedPrompts` heuristic flags two distinct turns that
happened to share prompt text ("ok"); it is text-level, not a double-capture —
`user_prompt` count (2) equals turn count (2), i.e. one prompt per turn.

### 6. Stats / logging sanity — PASS

`sdk.logging.query` across all threads: total 0 entries, 0 warnings/errors, 0
health failures. No `t3code-lhc` / drain / intake / lineage warnings in the server
logs. `CaptureService.stats()` exists but is **not exposed via any HTTP/WS
endpoint** (`LhcCaptureService` is an Effect layer in `server.ts`, not an RPC
surface) — reading the per-thread sqlite via the `lhc` inspect SDK is the reachable
path and it is clean. No alternate stats surface found.

### 7. Kill switches — PASS

- **`T3CODE_LHC_DISABLE=1`** (fresh `lhc-home-disable`): a Claude turn ran fine
  (`ready`) and `lhc-home-disable` was **never created** — no dirs/files. The
  service short-circuits to `disabledService()` before `ensureStateDirs`.
- **`T3CODE_LHC_NO_INFERENCE=1`** (fresh `lhc-home-noinf`, Codex turn): capture
  **was** recorded — thread sqlite, lineage `th_fdb44dc304e7cc92`, `user_prompt` +
  `assistant_text` + `tool_call` + `tool_result` (full seq output **108,938 bytes**),
  turns open:1/closed:1. **Zero inference children** spawned (polled
  `claude -p --model` throughout: 0). Derivations sit `pending` (4) — enqueued but
  never model-processed, which is the manual-mode design. **Positive control**
  (inference ON, same Codex-only setup so any `claude` is necessarily an inference
  child): the poll caught `claude -p --model sonnet …` (12 samples) — confirming the
  detector works and that inference ON does spawn children.

---

## Finding: `node`/`vp pack` cannot boot the server; a resolve hook is needed

Booting from source with plain `node apps/server/src/bin.ts` fails:
`ERR_MODULE_NOT_FOUND … packages/lhc-host/src/shared/claude-bin.js`. Node's native
type-stripping does not remap a `.js` import specifier to a sibling `.ts` file.
`packages/lhc-host/src/inference/claude-cli.ts:6` is the **only production source
file** in the workspace that authors a relative `.js` specifier
(`import { resolveClaudeBin } from "../shared/claude-bin.js"`); every other file
uses `.ts` (tsconfig `rewriteRelativeImportExtensions`). This also breaks the
server package's documented `dev` script (`node --watch src/bin.ts`, run by
`pnpm dev:server` → `vp run --filter=t3 dev`), unless `vp run` injects a loader.

`vp pack` (server `build:bundle`) is also unusable: the produced `dist/bin.mjs`
externalizes `effect` and imports top-level named exports (`import { Either,
ParseResult, Schema } from "effect"`) that this `effect` version does not provide
(`SyntaxError: … does not provide an export named 'Either'`).

**Workaround (boot tooling only, no source edits):**
`ts-js-resolve-hook.mjs` registers a resolve hook that remaps a relative `.js`
specifier to its `.ts` sibling when only the `.ts` exists, so
`node --import ./…/ts-js-resolve-hook.mjs apps/server/src/bin.ts serve …` runs the
server from source. This is a **finding**, not a fix — the one-character source
inconsistency (`.js` → `.ts` in `claude-cli.ts`) would remove the need for the hook
and unbreak `pnpm dev:server` under plain `node`; left for the owning package.

## Finding: browser `/oauth/token` exchange rejects the CLI startup credential

Exchanging the printed startup pairing `Token` at `POST /oauth/token`
(token-exchange grant, `subject_token_type: environment-bootstrap`) returns
**401 `auth_invalid` / `invalid_credential`**. The headless clients (`t3 connect`,
`t3 project`) do not use that path — they mint a bearer in-process via
`EnvironmentAuth.issueSession`. Documented in the auth recipe above; not a defect,
just a non-obvious sharp edge for a non-browser WS client.

---

## Costs observed

- **Provider turns:** ~17 across ~12 threads. Providers: Claude `claude-haiku-4-5`
  (cheapest) for all Claude turns; Codex `gpt-5.4`. Tool outputs kept small except
  the two intentional `seq 1 20000` runs (~109 KB each).
- **Inference derivations:** with inference ON, each captured turn triggers real
  `claude -p` calls (~1 `smoothed_prompt` per user prompt + ~1 `tool_result_summary`
  per tool result), ~20–25 calls total. **These run on `claude-sonnet-5`** (from
  `ccAssignments`, not operator-selectable) — the dominant per-turn LHC cost driver;
  worth flagging since the provider turns themselves were on cheap Haiku.

## Deviations

- Ran ~12 threads / ~17 turns vs the "~6–10 sessions" guidance — the extra turns
  were the drain-latency measurement (2 small turns) and the kill-switch positive
  control (2 small Codex turns); all on cheap models.
- Booted the server from source via a resolve hook rather than `pnpm dev:server`
  (browser/dev mode) or `vp pack` (broken bundle) — see the resolve-hook finding.
- WS auth uses an in-process-minted bearer (`t3 auth session issue`) → ws ticket,
  not the browser oauth exchange — see the oauth finding.

## Cleanup

- Servers booted on **port 4599** (base-dir `~/code/t3code-lhc/validation/t3home`),
  killed via SIGTERM when done. All scratch state is under
  `~/code/t3code-lhc/validation/` (outside the repo).
