# Revision request: Slice 1.2 capture service (verifier findings)

Verification found the fan-in fidelity clean (unbounded PubSub, no trimming/suppression,
only providerInstanceId canonicalization) and containment/lifecycle good. Seven fixes:

1. **Shutdown deadline bug (the important one).** `stop()` awaits `settleQueues()`
   UNCAPPED before the 30s drain deadline (`service.ts:298,403-405`) — a wedged intake job
   hangs shutdown forever and `killAllInferenceChildren()` never runs. Fix: the ENTIRE
   stop sequence (settle + drainSettled) runs under one 30s total deadline, and the child
   kill moves into a `finally` so no rejecting path can skip it.
2. **Forwarding-fiber hardening (small ProviderService addition, justified fork patch).**
   A provider/instance mismatch throw in canonicalization can kill that adapter's
   forwarding fiber (`ProviderService.ts:214` throw; `runForEach` at ~359 has no local
   catch) — killing ALL downstream consumers' feed from that adapter, ours and the
   server's own. Add a local catch in the forwarding loop: log and drop the poisoned
   event, keep the fiber alive. Keep it a few lines.
3. **Subscription-attached guarantee.** Capture's PubSub subscription starts via
   `forkScoped` (`server-layer.ts:54`) — events published before the fiber attaches are
   silently missed (live PubSub, no replay). Make layer construction await
   subscription-established (e.g. a Deferred signaled once the stream is attached) before
   yielding the service, so the "capture running" claim is deterministic.
4. **Observer unregister.** `registerTurnStartedObserver` is last-wins with no
   unregister — a stopped service's closure lingers. Return a disposer; service stop()
   calls it.
5. **FIFO queue policy.** Keep the queue unbounded (capture durability beats memory here —
   state the ruling in a comment) but add a pending high-watermark stat and a warning log
   (via sdk.logging, fail-soft) when a thread's pending count crosses 10k. Evict
   thread-state entries lazily: on enqueue, sweep entries whose queue is empty and idle
   > 10 minutes (no timers).
6. **Lineage doc line.** The lost-race residue is an orphan LHC thread file PLUS its LHC
   registry row (newThread registers), not "file only" — correct the comment.
7. **Test strengthening.** (a) Make the multi-thread ordering test genuinely concurrent:
   emit interleaved events for N threads via `Promise.all`-driven emission, assert
   per-thread order preserved. (b) Failure-injection test: assert the fail-soft log was
   actually written (query it back via `sdk.logging.query`), not just the stats counter.
   (c) Add a stop-under-wedged-queue test proving the 30s cap (use a tiny cap via test
   injection, not a real 30s wait).

Constraints: same as before. Package tests + `vp run typecheck` + `vp check` green.
Server diff still ≤2 source files (+manifest). No commits. Report diff + test results.
