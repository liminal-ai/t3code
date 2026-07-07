# Task: Phase 2 live acceptance run (Slice 2.4)

You are in a t3code fork. Everything is built: capture (live-validated in Slice 1.3),
the Claude rollout rebuilder, swap orchestration, and /lhc HTTP endpoints. This slice is
the first real execution of the full compact loop against a live server and real Claude
sessions. Deliverable: `docs/lhc/findings/phase2-acceptance.md` with a PASS/FAIL table.
No `git commit`. Paid calls authorized — keep the session model on **haiku** wherever
the API allows choosing (context-growing turns are the bulk; haiku keeps them cheap).

## Reuse, don't rediscover

- Server boot + WS auth recipe: `docs/lhc/findings/live-capture-validation.md` (the
  resolve-hook boot, port choice, token). Scratch home:
  `T3CODE_LHC_HOME=$HOME/code/t3code-lhc/validation/lhc-home-p2` (fresh).
- Driver: `packages/lhc-host/probes/ws-driver.ts` / `ws-scenario.ts`;
  record verifier: `probes/verify-lhc.ts`.
- HTTP endpoints: same auth as other raw routes — mint/read the token per the recipe;
  curl from there.
- Swap semantics ground truth: `docs/lhc/findings/claude-swap.md`; the two silent-swap
  tells to watch for (from the 2.2 audit): a `missing_source_rollout` error, and a
  first-turn "No conversation found" failure after swap.
- Provider sessions in fresh temp git repos. Do NOT send turns to a thread while its
  swap request is in flight.

## Checklist (each item gets PASS/FAIL + evidence in the findings doc)

1. **Grow**: one Claude thread, seed turn 1 with a codename ("the project codename is
   COPPER-IBIS-42; remember it") plus a distinctive fact. Then 4-6 turns of large tool
   output (`seq`-style, ~50-100KB each) until reported context usage is substantial
   (≥60k tokens by the provider's token-usage events — cite the number you reach).
2. **Status surfaces**: `GET /lhc/status` lists the thread with sane counts;
   `GET /lhc/threads/:id` returns overview + health; derivations mostly ready.
3. **Compact**: `POST /lhc/threads/:id/compact` (default profile) → 200 receipt. Verify
   receipt fields (old/new session id, rebuiltPath, stepReached absent/success, timings);
   the rebuilt rollout file exists at rebuiltPath; the persisted cursor names the new
   session id (read the session directory the way the findings doc shows).
4. **Resume onto compacted context**: next turn asks for the codename and the turn-1
   fact WITHOUT restating them. PASS requires: answer correct; stream/session evidence
   that the session started from the rebuilt id (not a fresh session, not the old id);
   reported context usage dropped materially vs item 1's peak (cite before/after).
5. **Continuity**: 2 more small turns. Capture keeps appending to the SAME LHC thread
   (event count grows, no new lineage row); the rebuilt rollout file gains the new turns.
6. **Auto-compact suppression (Slice 2.3 live proof)**: during the whole run,
   provider context-usage events report `compactsAutomatically: false`, and the native
   rollout contains no `compact_boundary` lines. Control: reboot server with
   `T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0`, one cheap turn on a new thread, confirm
   `compactsAutomatically: true` (then kill that server).
7. **Prune**: on the same thread (or a second grown thread if cleaner), `POST .../prune`
   → 200 receipt, next turn works, record intact.
8. **Error surfaces**: `POST compact` on an unknown thread id → 404 `not_captured`;
   `POST compact` while a turn is in flight → 409 `busy` (start a slow turn, fire the
   request, then let the turn finish); second compact while one is in flight on the same
   thread → 409 (only if cheap to arrange; skip if flaky and say so).
9. **Sanity sweep**: LHC log warnings, capture stats via status endpoint, server logs
   for LHC errors — report anything non-clean.

## Failure protocol

Same as 1.3: evidence, FAIL line, continue unless blocked. If item 4 fails with either
silent-swap tell, capture BOTH the rebuilt file's first lines and the session directory
cursor state before touching anything — that evidence distinguishes path-mismatch from
cursor-mismatch, and determines the fix. Do not patch code; findings only (probe-script
fixes fine). Kill all servers when done.

## Report back

PASS/FAIL table, per-item evidence, before/after context-usage numbers, total cost
estimate, the exact boot+curl recipe used, and your list of anything Phase 3 should
absorb.
