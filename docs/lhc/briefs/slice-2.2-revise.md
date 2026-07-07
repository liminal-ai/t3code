# Revision request: Slice 2.2 swap orchestration (verifier findings)

Verification: core ACCEPT (flip-last structural, upsert merge semantics, quiesce
sufficiency, sequencing, endpoints auth parity, test honesty). REVISE on two findings +
one polish item.

1. **Window B — post-flip contested-swap guard (the required fix).** Nothing blocks a
   user `sendTurn` between quiesce and flip: it auto-starts a fresh session from the OLD
   cursor, and its own cursor persist (`ProviderService.ts:306-314`, `:734-739`) can land
   AFTER your flip — silently undoing it while the receipt reports success. A lying
   receipt is not acceptable. Fix:
   a. Immediately before the flip (after quiesce), check whether a session became active
   for the thread mid-swap → abort cleanly (`flip_contested`, retriable 409-class;
   cursor untouched, invariant preserved).
   b. Immediately after the flip, re-read the persisted cursor. If it no longer names the
   rebuilt session id, the flip was clobbered: retry the flip ONCE iff no session is
   currently active; otherwise (or if the re-flip is also clobbered) return a
   structured `flip_contested` failure — never a success receipt. Include what was
   observed in the error detail.
   c. Document the concurrency model where the lock is declared: the swap lock serializes
   swaps only; sendTurn is not blocked; contested flips are detected post-hoc, not
   prevented. Also document Window A semantics (turn in flight at busy-check race gets
   interrupted by quiesce; its content survives in the LHC record but drops from the
   resumed Claude context — accepted v1 behavior).
2. **Default-home derivation alignment (required).** For instances with empty `homePath`,
   `makeClaudeEnvironment` leaves env unchanged → the SDK's HOME is `process.env.HOME`,
   but your derivation uses the continuationKey's `path.resolve(os.homedir())`. Align:
   empty/default homePath → derive from `process.env.HOME ?? os.homedir()`, and realpath
   the resolved home before deriving the projects dir (matching writeRebuiltRollout's
   internal realpath posture). Keep continuationKey parsing for explicit per-instance
   homes (exact there). Add a unit test covering the divergence scenario (HOME env set to
   a symlinked/trailing-slash variant → derivation still lands where the SDK will look).
3. **Error-mapping polish (small):** `capture_disabled` → 503; `missing_provider_binding`
   → 409 with retriable:false; keep the rest. Update the endpoint tests.

New tests required: contested-flip (fake provider where a concurrent cursor upsert lands
after the flip → assert structured failure, no success receipt; and the retry-once-when-
idle path), plus the home-derivation test above.

Constraints unchanged: lhc-host + touched server suites green, `vp run typecheck` +
`vp check` green, no commits. Report the diff and how the guard behaves in each window.
