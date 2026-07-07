# Task: endpoint consolidation, test hardening, operations doc (Slice 3.1)

You are in a t3code fork with the full LHC Claude loop working (see
`docs/lhc/findings/phase2-acceptance.md`). This slice consolidates: small endpoint
improvements, three test-hardening items from the acceptance run, and an operations doc.
No new architecture — read `docs/lhc/impl-log.md` (last three entries) and the acceptance
findings first.

## 1. Endpoint improvements (`packages/lhc-host/src/http.ts` + swap/capture as needed)

- `GET /lhc/threads/:id`: include the LHC `viewStatus` fields the acceptance run showed
  matter — `tailTokens`, `compactRecommended` (see how `swap/claude.ts` obtains
  threadView status; expose the same read-only). Operators must be able to see
  compact-worthiness from the endpoint alone.
- `GET /lhc/status`: add per-thread `lastActivityAt` and the capture stats `pending`/
  `pendingHigh` if not already surfaced.
- Keep response shapes backward compatible (additive only).

## 2. Test hardening (from the 2.4 absorb list)

- **Deterministic `swap_in_progress`**: in the orchestrator tests, inject a slow step
  (e.g. a gated quiesce that awaits a test-controlled promise), fire a second
  compact for the same thread while the first is parked → assert 409-class
  `swap_in_progress`; release the gate → first completes normally.
- **Suppression integration assert**: confirm (or add) a test asserting the SDK session
  createInput carries `settings.autoCompactEnabled: false` through the REAL adapter
  session-start path when suppression is on — this is the control the live run couldn't
  isolate (the box's user settings already disable auto-compact). If the 2.3 tests
  already cover exactly this, say so and point at them instead of duplicating.
- **viewStatus assertions**: extend the swap integration test to assert
  `tailTokens > 0` and `compactRecommended` is a boolean in the pre-compact view status
  (and that the endpoint response carries them per item 1).

## 3. Operations doc (`docs/lhc/operations.md`)

Written for an operator (Lee) running this fork on a new box. Consolidate from the
findings docs — do not invent:

- State layout (`~/.t3code-lhc/`), env flags (`T3CODE_LHC_HOME`, `_DISABLE`,
  `_NO_INFERENCE`, `_SUPPRESS_AUTOCOMPACT`) and what each actually does.
- Server boot recipe (from `live-capture-validation.md`, including the resolve hook and
  WS/HTTP auth token) — condensed, copy-pasteable.
- The curl book: status, inspect, compact, prune — with example responses and the error
  codes (404/409/503/500 + stepReached, flip_contested semantics).
- Troubleshooting: the two silent-swap tells and what each means; busy/locked handling;
  what to check when derivations aren't draining (inference lane, cap 8, claude bin);
  kill switches; where logs live (LHC log + server logs).
- Known limits (one-liners with pointers): Window A interrupted-turn loss; contested-flip
  post-hoc detection; per-thread swap lock scope; user-settings interaction with
  suppression; rollback/fork in the t3 UI not LHC-aware.

## Acceptance

- lhc-host tests green (including the new ones); ClaudeAdapter suite green if touched;
  `vp run typecheck` + `vp check` green at root.
- Doc is accurate against the code as of this slice — no aspirational content.
- No `git commit`.

## Report back

Endpoint diff summary, which hardening items were added vs already covered, doc path,
test results.
