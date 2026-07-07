# LHC Phase 4 live acceptance run (Slice 4.3) — Codex swap

First real end-to-end execution of the LHC compact/prune loop on a **Codex**
thread, driven over the real WebSocket API against a live server, exercising the
`/lhc` HTTP endpoints (which now route by `providerKind`). The codex resume
mechanism was proven in Slice 4.0 (`codex-swap.md`), the rebuilder ported in 4.1,
and the swap orchestration wired in 4.2; this run is the first time the whole
codex path executed against a live server. Mirrors the Phase 2 acceptance
(`phase2-acceptance.md`).

- **Date:** 2026-07-07
- **Scratch LHC home:** `~/code/t3code-lhc/validation/lhc-home-p4` (real
  `~/.t3code-lhc` untouched).
- **Server base dir:** `~/code/t3code-lhc/validation/t3home-p4`, **port 4603**,
  host `127.0.0.1`.
- **Provider:** Codex `gpt-5.4-mini` + `reasoningEffort: low` (cheapest usable;
  `gpt-5.4-mini` is the smallest model in the box's `models_cache.json`). Codex
  runs in the real `~/.codex` home (`direct` mode — see item 10); rebuilt
  rollouts land in `~/.codex/sessions/YYYY/MM/DD/`, as designed (LHC does not
  relocate rollouts). Scratch git-repo cwds under
  `~/code/t3code-lhc/validation/repos/*`.
- **No `git commit` was made.** New files: `packages/lhc-host/probes/phase4-acceptance.ts`,
  this doc; plus a small backward-compatible extension to `ws-driver.ts` (optional
  `modelSelection` override on `runTurn` / `createProjectAndThread`).

## Result summary

| #   | Item                                        | Result   | Headline evidence                                                                                                                                                                                                                                                                                                                                |
| --- | ------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Grow (codename + fact, large tool output)   | **PASS** | Seed set `COBALT-HERON-59` + lucky `8317`; 4 seq turns (20k→80k). Codex `usedTokens` grew monotonically **12,422 → 27,506** (codex context accumulates, unlike Claude); LHC `tailTokens` **596,608**, `compactRecommended:true`.                                                                                                                 |
| 2   | Status / inspect                            | **PASS** | `GET /lhc/status` lists thread `providerKind:"codex"` (events 27, turns 6); `GET /lhc/threads/:id` → `tailTokens 596,608`, `compactRecommended true`, threshold 160,000, derivations draining.                                                                                                                                                   |
| 3   | Compact                                     | **PASS** | `POST …/compact` → **200** full receipt (`stepReached` absent); rebuilt under `~/.codex/sessions/2026/07/07/rollout-…-5e2d0611….jsonl`; **filename == session_meta id == session_id**; persisted cursor bare `{threadId:5e2d0611…}`.                                                                                                             |
| 4   | Resume onto compacted context               | **PASS** | Recall **correct & unrestated**: `codename=COBALT-HERON-59 lucky=8317`; resume turn appended to the **rebuilt** file (5→16 lines); cursor names new id; codex `usedTokens` **27,506 → 14,520**; no silent-swap tells.                                                                                                                            |
| 5   | Continuity (2 turns)                        | **PASS** | Same LHC thread `th_24ecd482cb563881` (no new lineage row); rebuilt synthetic file grew **16 → 34** lines; overview events 27 → 37.                                                                                                                                                                                                              |
| 6   | Second swap, **quiesced** thread (4.2 risk) | **PASS** | Session explicitly stopped (`status:stopped, activeTurnId:null`); **no turn sent**; `POST …/compact` → **200** (chained swap 5e2d0611…→3a79bfbe…), next turn `ready`. cwd resolved from the binding — risk did not manifest (root-caused below).                                                                                                 |
| 7   | Prune                                       | **PASS** | `POST …/prune` → **200** (chained 3a79bfbe…→de055078…, rebuilt 19 lines, `total 16 ms`, `runtimeNote.recorded:true`); next turn `ready`.                                                                                                                                                                                                         |
| 8   | Error surfaces (+ mixed-provider)           | **PASS** | Unknown → **404** `not_captured`/`resolve-lineage`; busy → **409** `busy`/`busy-check`/`retriable:true` (session `running`, `activeTurnId` set); **CLAUDE compact → 200** routed to the claude flow (claude-style cursor, rollout under `~/.claude/projects`).                                                                                   |
| 9   | Sanity sweep                                | **PASS** | LHC per-thread logs **0 total / 0 warnings**; derivations **54 ready, 0 pending/retrying/failed/blocked**, `health.failures:[]`; capture `eventsSeen 332, eventsIgnored 0`, intake `failedBatches 0, intakeThrew 0, lineageFailures 0`; server log has no lhc/codex-swap/error lines. `maxToolResultBytes 468,938` (full-fidelity, untruncated). |
| 10  | authOverlay note                            | **N/A**  | Box runs codex in **`direct`** mode: default `CodexSettings.shadowHomePath = ""` and every live `codex app-server` process has `CODEX_HOME` unset (→ `~/.codex`). authOverlay (shadow-home symlink) is not exercisable here without configuring `shadowHomePath`. Not faked.                                                                     |

**All 10 checklist items PASS** (item 10 is a documentation item, correctly
**N/A** with evidence). No FAIL, no PARTIAL. The codex compact/prune/resume loop
works end-to-end against a live server, and the 4.2 provider dispatch is proven
in both directions (codex → codex flow, claude → claude flow) without regressing
Claude.

Primary thread: t3 `5781034b-11e4-418d-9035-d5fdead9494f` → LHC
`th_24ecd482cb563881`. Mixed-provider claude thread: LHC `th_bf69ed73909a2a45`.

---

## Server boot + WS auth + curl recipe (as used)

Reused verbatim from `operations.md` / `live-capture-validation.md`, port 4603.

```sh
export T3CODE_LHC_HOME=$HOME/code/t3code-lhc/validation/lhc-home-p4   # NEVER ~/.t3code-lhc
export BASE=$HOME/code/t3code-lhc/validation/t3home-p4

# 1. boot (suppression defaults ON; gate is T3CODE_LHC_DISABLE)
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts serve --port 4603 --base-dir "$BASE" --host 127.0.0.1

# 2. mint a reusable bearer (orchestration:read + orchestration:operate)
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  packages/lhc-host/probes/ws-scenario.ts auth --base-dir "$BASE" --out "$BASE/driver-auth.json"

# 3. curl /lhc with that bearer
TOK=$(node -e "console.log(require('$BASE/driver-auth.json').accessToken)")
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:4603/lhc/status
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4603/lhc/threads/<t3ThreadId>/compact
```

Full flow driven by `probes/phase4-acceptance.ts` (WS turns via `ws-driver.ts`
with a custom `gpt-5.4-mini`/`reasoningEffort:low` model selection; `fetch` for
the endpoints; codex-rollout JSONL parsing for the authoritative recall; inline
`node:sqlite` reads of `provider_session_runtime` for cursor/runtimePayload):

```sh
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  packages/lhc-host/probes/phase4-acceptance.ts \
  --auth "$BASE/driver-auth.json" --repo "$V/repos/p4-codex" \
  --claude-repo "$V/repos/p4-claude" --base "$BASE" \
  --codex-home "$HOME/.codex" --out "$V/phase4-journal.json"
```

Persisted cursor + runtimePayload read (items 3/6):

```sh
sqlite3 -json "$BASE/userdata/state.sqlite" \
  "SELECT thread_id, resume_cursor_json, runtime_payload_json FROM provider_session_runtime;"
```

---

## Context-usage numbers (before/after)

Unlike Claude (Phase 2: `usedTokens` plateaus ~26k due to in-context tool-output
truncation), **codex context accumulates across turns** — the provider counter is
a usable growth signal here:

| turn (seq)           | seq size | codex `usedTokens` |
| -------------------- | -------- | ------------------ |
| seed (`noted`)       | —        | **12,422**         |
| grow 1               | 20,000   | 16,713             |
| grow 2               | 40,000   | 20,963             |
| grow 3               | 60,000   | 25,246             |
| grow 4               | 80,000   | **27,506** (peak)  |
| after compact+resume | —        | **14,520**         |

The compact dropped the provider counter **27,506 → 14,520** (~47%). LHC's own
view is the larger signal, as designed: `tailTokens` peaked at **596,608**
(`compactRecommended:true`, threshold 160,000) and collapsed to **356** after the
final prune. Full tool output was captured untruncated (`maxToolResultBytes
468,938` = the `seq 80000` result).

---

## Per-item evidence

### 1. Grow — PASS

Seed turn planted `COBALT-HERON-59` + lucky `8317` (codex replied, no tools).
Four escalating `seq` turns (20k→80k) each `ready`. Codex `usedTokens` climbed
12,422 → 27,506; activity kinds seen: `context-window.updated ×9`, `tool.started
×4`, `tool.completed ×4`. LHC captured full fidelity (`tailTokens 596,608`,
`compactRecommended:true`). Cited peak: **27,506** codex / **596,608** LHC.

### 2. Status / inspect — PASS

`GET /lhc/status` → the thread listed with `providerKind:"codex"`, `lhcThreadId
th_24ecd482cb563881`, sane counts (events 27, turns 6). `GET /lhc/threads/:id` →
`tailTokens 596,608`, `compactRecommended true`, `viewStatus.threshold 160,000`,
`derivation {pending:0, retrying:0, failed:0, blocked:0}`.

### 3. Compact — PASS

`POST …/compact` (`{}` body) → **200**. Receipt:

```
op=compact  old=019f3eb6-7bf1-7353-b14f-e4ffbd66b43a  new=5e2d0611-8cc0-495b-90ef-17debc985ff1
rebuiltPath=~/.codex/sessions/2026/07/07/rollout-2026-07-07T18-33-17-5e2d0611-…jsonl
rebuilt={lineCount:5, expectedReintakeLines:5, replayedPrefixLines:3}
cursor={threadId:5e2d0611-…}          timings.total=40 ms   runtimeNote={recorded:true}
```

`stepReached` absent on success. Rebuilt file line 1 is a valid `session_meta`
with `payload.id == payload.session_id == 5e2d0611-…` **== the filename suffix**
(the 4.1 id-invariant guard holding live), `cwd` = the thread's scratch repo,
`originator: codex-lhc`. File is under the dated `sessions/2026/07/07/` path. The
persisted cursor (`state.sqlite`) is the bare `{threadId:5e2d0611-…}` — the exact
Codex cursor shape, naming the new id.

### 4. Resume onto compacted context — PASS

Recall turn asked for the codename + lucky number **without restating them**.
Authoritative answer (parsed from the rebuilt rollout — the text codex actually
wrote): **`codename=COBALT-HERON-59 lucky=8317`** (both correct). Session
provenance that it resumed the **rebuilt** id: the resume user+assistant lines
were appended to the rebuilt file (5 → 16 lines), the persisted cursor names the
new id, and no silent-swap tell appeared — **no `no rollout found for thread id`**
in the server log and the turn settled `ready` (not a fresh no-recall session).
Usage delta cited: codex `usedTokens` 27,506 → 14,520. The rebuilt rollout also
carries a `[runtime note]` line recording the compact and a synthetic
`<environment_context>` with the correct cwd.

### 5. Continuity — PASS

2 more `ok` turns, both `ready`. Capture kept the **same** LHC thread
`th_24ecd482cb563881` (no new lineage row across all inspects); the synthetic
rebuilt file grew **16 → 34** lines (codex appended the new turns to the resumed
synthetic rollout); overview events 27 → 37.

### 6. Second swap on a quiesced thread — PASS (4.2 risk item did not manifest)

After the last continuity turn, the session was **explicitly stopped** via the API
(`thread.session.stop`) and confirmed idle (`status:stopped, activeTurnId:null`).
**No turn was sent.** `POST …/compact` → **200**, a chained swap
(old `5e2d0611-…` = the first compact's new id → new `3a79bfbe-…`,
`total 27 ms`, `runtimeNote.recorded:true`); the next codex turn returned `ready`.

Root cause it works (and why 4.2 flagged it): the swap's cursor-flip
(`server.ts` `writeResumeCursor`) upserts `runtimePayload = {lastRuntimeEvent,
lastRuntimeEventAt}` — **without** `cwd`. But `ProviderSessionDirectory.upsert`
**merges** runtimePayload (`{...existing, ...next}`,
`ProviderSessionDirectory.ts:47,143`), so the `cwd` written at session start
(`toRuntimePayloadFromSession`, `ProviderService.ts`) survives every swap. The
binding snapshot taken **immediately before** the quiesced compact confirms it:
`runtimePayload.cwd = …/repos/p4-codex` was present with no active session, so
`resolvePaths` → `persistedCwdFromBindingOrSession` resolved cwd from the binding
alone. **The known cwd-drop concern is mitigated by the merge semantics; no paths
error occurred.** (Latent caveat carried to Phase 5 below.)

### 7. Prune — PASS

Session re-quiesced, `POST …/prune` → **200**: chained swap
(old `3a79bfbe-…` → new `de055078-…`), `rebuilt {lineCount:19,
expectedReintakeLines:19, replayedPrefixLines:17}`, `total 16 ms`,
`runtimeNote.recorded:true`, filename==meta-id holds. Next turn `ready`.

### 8. Error surfaces + mixed-provider — PASS

- **Unknown thread** → **404** `{code:"not_captured", stepReached:"resolve-lineage"}`.
- **Busy** (compact fired ~2.5 s into an in-flight slow `seq`/`sleep` turn) →
  **409** `{code:"busy", stepReached:"busy-check", retriable:true}`; monitor
  confirmed the session `running` with `activeTurnId 019f3eb7-…` at fire time.
- **Mixed-provider dispatch** (the 4.2 refactor's first live exercise + Claude
  regression proof): a small CLAUDE thread (`claude-haiku-4-5`, seed turn `ready`)
  → `POST …/compact` → **200**, routed to the **claude** controller — the receipt
  cursor is the **claude-shaped** `{threadId, resume, turnCount}` and the rebuilt
  rollout is under `~/.claude/projects/…` (not a codex `sessions/` path).
  Confirms `lhcSwapDispatchTarget` routes `codex`→codex and `claudeAgent`→claude,
  and that the shared-core refactor did not break the Claude flow.

### 9. Sanity sweep — PASS

`verify-lhc` on the codex thread: **logs total 0, 0 warnings**; derivations
`ready:54, pending:0, retrying:0, failed:0, blocked:0`; every inference owner
drained (`smoothed_prompt 11/11`, `tool_result_summary 4/4`,
`detailed_turn_compression 13/13`, `pre_detailed_assembly 13/13`, …);
`health.failures:[]`. Status endpoint: `eventsSeen 332, eventsIgnored 0`, intake
`failedBatches:0, intakeThrew:0, lineageFailures:0`. Server stderr has **no**
`lhc`/`codex-swap`/`error`/`warn` lines. `maxToolResultBytes 468,938` = full,
lossless capture of the largest `seq` tool_result.

### 10. authOverlay — N/A (with evidence)

The box runs codex in **`direct`** mode, so the authOverlay (shadow-home symlink)
path is not exercised here:

- Default `CodexSettings.shadowHomePath = ""` (`packages/contracts/src/settings.ts:182`);
  `resolveCodexHomeLayout` returns `mode:"direct"` when `shadowHomePath` is empty
  (`CodexHomeLayout.ts:48-54`).
- The fresh `t3home-p4` base has no codex config overriding this.
- Every live `codex app-server` process has **`CODEX_HOME` unset** (→ `~/.codex`),
  and no shadow-home dir (e.g. `~/.codex-t3`) exists.

Exercising authOverlay would require configuring a `shadowHomePath` on the codex
instance; deferred, not faked. Note for Phase 5: when a shadow home _is_
configured, `deriveCodexSwapHomePath` reads `continuationKey = codex:home:<sharedHomePath>`
(the shared home, where `sessions/` lives) — which is the correct target for
rollout discovery, but this has not been live-verified.

---

## Deviations

- **Cheapest model:** used `gpt-5.4-mini` + `reasoningEffort: low`. `ws-driver`'s
  default codex selection is `gpt-5.4` (default reasoning); extended `runTurn` /
  `createProjectAndThread` with an optional `modelSelection` override
  (backward-compatible) to inject the mini model. The seed turn confirmed the
  selection is accepted and codex authenticates.
- **Streaming assistant text is empty for codex** (`thread.message-sent` role
  `assistant` text `""`), same class of issue Phase 2 flagged for the streaming
  extractor. The rebuilt-rollout parse (`response_item` `output_text`) was the
  authoritative recall source and returned the exact answer — reuse that pattern.
- **Single clean run**, no reruns needed (unlike Phase 2's three). All 10 items
  passed on the first execution.

## Costs observed

- **Provider turns:** 11 codex turns (`gpt-5.4-mini`, low reasoning) + 1 claude
  `haiku` turn — cheap. Codex swaps: 3 compacts + 1 prune (near-instant, ≤40 ms
  each). 3 codex-lhc rebuilt rollout files written to `~/.codex/sessions/2026/07/07/`.
- **Inference lane (dominant cost):** inference ON (default) → each captured codex
  turn drove real `claude -p` `smoothed_prompt` + `tool_result_summary` +
  turn-compression derivations **on `claude-sonnet-5`** (`ccAssignments`),
  including summaries over the 108–468 KB `seq` tool_results. Same cost driver as
  Phase 2 / Slice 1.3.
- **Rough total estimate: ~$3–6**, dominated by the sonnet inference lane (fewer,
  smaller `seq` turns than Phase 2, so lower).

## Cleanup

Server (port 4603, pid 38809) killed at end of run. All scratch state under
`~/code/t3code-lhc/validation/` (outside the repo); real `~/.t3code-lhc` untouched.
Codex rollouts (live + 3 rebuilt) landed in the real `~/.codex/sessions/2026/07/07/`
under scratch-repo cwds, as designed — the real `~/.codex` config was not modified.

---

## Punch-list for Phase 5

1. **cwd-drop is latent, not dead.** Item 6 passed only because
   `mergeRuntimePayload` preserves `cwd` across the swap's cursor-flip. The flip's
   `writeResumeCursor` still writes a `runtimePayload` that _omits_ `cwd`; if that
   merge behavior ever changes (or a code path replaces rather than merges
   runtimePayload), the quiesced-swap path breaks with "Codex thread has no
   persisted cwd." Consider having the swap flip carry `cwd` explicitly, or add a
   regression test asserting the merge preserves it.
2. **authOverlay is unverified live.** The `direct`-mode continuation key resolves
   correctly, but `mode:"authOverlay"` (shadow home; `continuationKey` =
   `codex:home:<sharedHomePath>`, sessions under the shared home) has never been
   exercised end-to-end. Phase 5 should stand up a shadow-home codex instance and
   confirm rollout discovery + rebuild land in the shared `sessions/`.
3. **Rollout discovery walks the whole `~/.codex/sessions` tree.**
   `findCodexRolloutBySessionId` does an unbounded DFS over `sessions/` (here a
   ~2 GB tree with years of dated dirs). It found the target fast enough
   (`resolve-paths` ≤ 0 ms in the receipts, i.e. sub-ms), but a date-scoped search
   (start at today's `YYYY/MM/DD`, widen only on miss) would bound worst-case cost
   on large homes.
4. **Codex `usedTokens` IS a usable growth signal** (unlike Claude) — it
   accumulated across turns and dropped materially on compact. Worth surfacing
   both counters, but note the divergence between providers when documenting the
   acceptance metric.
5. **Streaming assistant-text extraction is empty for codex** over the WS
   `thread.message-sent` stream. If future probes/tests read answers from the
   stream, prefer the rebuilt-rollout / LHC capture, matching Phase 2's finding.
