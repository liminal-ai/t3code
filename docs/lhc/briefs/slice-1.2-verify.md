# Verification task: audit Slice 1.2 capture service + server wiring (read-only)

Read-only: no file changes, no commits, no paid calls. You may run package tests and the
two server test suites the implementer cited, plus read-only shell.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-1.2.md`.
Under audit: uncommitted diff — `packages/lhc-host/src/{paths,config,lineage}.ts`,
`src/capture/service.ts`, `src/server-layer.ts`, tests; `apps/server/src/provider/Layers/
ProviderService.ts` (+31 hook), `apps/server/src/server.ts` (+24), `apps/server/package.json`.

## Check, in priority order

1. **THE FAN-IN FIDELITY QUESTION (highest stakes).** Capture consumes
   `ProviderService.streamEvents` instead of raw `adapter.streamEvents`. The Phase-0
   fidelity findings were probed on the RAW adapter streams. Read the ProviderService
   fan-in path (`reconcileInstanceSubscriptions` and everything between adapter stream and
   the PubSub the service exposes): is any event dropped, transformed, truncated, or
   suppressed on the way (child/subagent conversation suppression, payload trimming,
   backpressure drop policy, PubSub bounded-capacity eviction)? If the PubSub is bounded
   and a slow consumer can silently lose events, that is a capture-integrity finding —
   name the capacity and drop semantics. Verdict must state: byte-parity yes/no, loss
   modes if any.
2. **The sendTurn hook.** Module-level `registerTurnStartedObserver`: can an observer
   throw ever reach the turn path (read the helper's try/catch placement)? Multiple
   registrations / re-registration on layer rebuild — leak or last-wins? Does it fire
   only on SUCCESSFUL sendTurn (adapter accepted), with the adapter-assigned turnId?
   Is `input.input ?? ""` the right prompt source (what about attachments-only turns —
   empty prompt event acceptable)?
3. **Per-thread FIFO workers.** Promise-chain per thread: strict ordering, error in one
   item doesn't break the chain, no unbounded growth if intake stalls (what bounds the
   queue?), worker map cleanup (thread finished — entries evicted or grow forever?).
4. **Layer/lifecycle claims.** Verify from server.ts composition: starts after provider
   registry; finalizer order stops capture before ProviderService teardown; disabled mode
   (`T3CODE_LHC_DISABLE=1`) truly no-ops (no dirs created, no SDK constructed);
   `T3CODE_LHC_NO_INFERENCE=1` → manual mode + deterministic callbacks + drain-settle
   skipped.
5. **Lineage.** file-then-row with INSERT OR IGNORE + re-select: confirm the lost-race
   path converges (both callers end with the winner's LHC thread id) and the orphan file
   is the only residue. Any path where a row exists without a thread file (the bad
   direction)?
6. **Shutdown.** stop(): flush → drainSettled under ONE 30s total deadline → child kill;
   idempotent; capped even if a thread's queue is wedged.
7. **Tests.** Run the package suite + the two server suites. Read the capture tests: do
   ordering and both-orders dedupe tests genuinely race the paths they claim (or are they
   sequenced so the assertion is trivial)? Failure-injection test actually exercises the
   fail-soft path through `sdk.logging`?
8. **Containment.** No lhc-host imports/types in provider modules beyond the hook; server
   diff is reviewable in isolation; nothing else in apps/server touched.

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, file/line specifics. Item 1
verdict first.
