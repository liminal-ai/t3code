# Verification task: audit Slice 2.2 swap orchestration (verify, don't fix)

No file modifications, no commits, no paid provider calls. You may run package tests and
any server suites touched, plus read-only shell.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-2.2.md` (read fully).
Ground truth: `docs/lhc/findings/claude-swap.md`.
Under audit: uncommitted diff — `packages/lhc-host/src/swap/claude.ts`, `src/http.ts`,
capture service additions, `apps/server/src/server.ts` route wiring, tests.

## Check, in priority order

1. **Home/cwd derivation (the silent-failure trap).** The rebuilt rollout must land in
   the EXACT projects dir the Agent SDK will search on resume, and the envelope cwd must
   match. Trace the implementer's derivation ("provider instance continuation key" +
   persisted session runtime payload) against how ClaudeAdapter/ClaudeHome actually
   resolve HOME and cwd for a session. Any scenario (default home vs per-instance
   homePath, cwd symlinks/realpath, instance reconfigured mid-thread) where the
   derivation diverges from what resume will use? A divergence here fails SILENTLY as a
   fresh session — the worst failure mode in the findings doc. Also: is realpath applied
   consistently with what writeRebuiltRollout does internally?
2. **Cursor flip.** Exact adapter shape `{threadId, resume, turnCount}` via
   `ProviderSessionDirectory.upsert` — compare field-for-field with what
   `updateResumeCursor` writes and what session start reads. turnCount source correct?
   Does upsert merge or replace (could a partial object clobber fields the adapter needs)?
   Is `resume` guaranteed a uuid (non-uuid = silent fresh session)? Flip genuinely the
   last mutating step — read the code path, not the comment.
3. **The busy-check → quiesce race (TOCTOU).** The lock is lhc-host-internal; nothing
   stops a user sending a new turn between the busy check and stopSession, or between
   stopSession and cursor flip (a new sendTurn would auto-start a session from the OLD
   cursor mid-swap). Map the actual windows: what happens in each? Is the outcome benign
   (swap fails cleanly / turn lands on old context and swap receipt reports it) or
   corrupting (rollout/cursor mismatch)? The 0.3 findings accept a documented benign
   race for v1 — verify it IS benign and IS documented, or flag as REVISE.
4. **Quiesce sufficiency.** Does `stopSession` resolve only after the Agent SDK session
   is actually torn down (in-memory context gone, rollout file closed), or is it
   fire-and-forget? Interaction with the session reaper — could the reaper or a
   concurrent stop double-fire and race the rebuild?
5. **LHC op + view + rebuild sequencing.** Compact/prune runs on the capture service's
   SDK instance (no second SDK constructed)? Post-op view is what gets rebuilt (not
   pre-op)? Receipt runtime-note written to the LHC record AFTER success only?
6. **Endpoints.** Auth posture: are the /lhc routes behind the same auth as neighboring
   local routes (not accidentally open)? Status/inspect read paths can't mutate. Error
   mapping (404 no-lineage, 409 busy/locked, 500 structured with step-reached) matches
   the handlers. Server.ts wiring containment.
7. **Capture-service additions.** `lookupThread`/`listCapturedThreads` — read-only,
   no interference with intake workers, existing capture tests still green.
8. **Test honesty.** Injected-step tests: do failure-at-each-step tests actually assert
   the cursor was NOT written (spy on the write, not just absence of receipt)? Does the
   ordering test pin flip-last structurally? Integration test uses a REAL compact on a
   real SDK thread?

Run: lhc-host suite, and ProviderService/ClaudeAdapter suites if their files changed.
If the sandbox blocks test runs, say so; audit statically.

## Report

Verdict per item (item 1 first), overall ACCEPT or REVISE-with-findings, file/line
specifics, and your list of open risks for the 2.4 live run.
