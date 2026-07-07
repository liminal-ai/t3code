# Task: multi-thread drain concurrency validation harness (Slice 0.4)

You are in a worktree of a t3code fork. `packages/lhc-host` links an external SDK ("lhc",
long-horizon context: per-thread SQLite files, durable work queue, background drain
scheduler). The SDK was designed for many threads per process but has only ever been
exercised with one. Your job: build a test harness that validates (or breaks) multi-thread
behavior, and write an evidence-cited findings report.

Setup note: run `pnpm install` at the repo root first (fresh worktree, no node_modules).
The SDK is linked from `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc`
(prebuilt dist; treat that repo as strictly read-only).

## Background you must read first (in the SDK repo, read-only)

- `packages/lhc/src/sdk.ts` — `initLhc`, background vs manual mode, `drainSettled`,
  the instance seam
- `packages/lhc/src/shared-tech/` — scheduler (per-thread single-flight, pending
  coalescing, wake timers), work-queue (claim/complete transactions, epoch fencing,
  retry/backoff), and the existing tests for both
- `docs/onboard/02-domain-design.md` in that repo — "Shared-tech utils" section
  (scheduler, durable work queue) for the design intent
- `packages/lhc-host/src/sdk-smoke.test.ts` in THIS repo — working construction example

## What to build

`packages/lhc-host/test/concurrency/` — a harness (vitest, runnable via the package's test
script but in its own file(s), plus a standalone `run-load.ts` entry if that's cleaner for
long runs) that:

1. Constructs ONE background-mode SDK instance with **injected inference callbacks** (the
   `inferenceCallbacks` construction path) that simulate latency: configurable base delay +
   jitter (e.g. 300–1500 ms), optional failure rate. All storage under a temp dir.
2. Creates N threads (default 10) and drives concurrent intake: interleaved realistic
   batches (user_prompt → assistant_text/thinking → tool_call/tool_result pairs → turn_end),
   multiple turns per thread, arriving concurrently across threads (Promise-level
   concurrency, not just sequential loops).
3. Lets background drains run and measures, per thread and globally:
   - time from turn_end to derivation-queue-empty (`drainSettled` per thread)
   - drain starvation: max staleness of the oldest queued item across the run
   - derivation end-states via `inspect.health` (ready/failed/blocked counts — expect all
     ready with 0 failure rate injected)
   - wall-clock event-loop stalls (e.g. a 50 ms heartbeat timer; report max observed lag)
4. Asserts correctness invariants after quiesce: every thread's record intact
   (message/turn counts match what was sent), no cross-thread contamination (spot-check
   message content per thread), no leftover queued work, no failed derivations (when
   failure rate is 0).
5. A second scenario with injected failures (e.g. 20% retryable) asserting retries/backoff
   don't wedge other threads' drains.
6. Scale knobs via env (`LHC_LOAD_THREADS`, `LHC_LOAD_TURNS`) with CI-safe defaults
   (10 threads × 3 turns must run in tens of seconds, not minutes).
7. OPTIONAL, flag-gated OFF by default (`LHC_LOAD_REAL_INFERENCE=1`): swap callbacks for a
   real `claude -p` subprocess call (see the pattern in liminal-context
   `packages/cc-lhc/src/inference/claude-cli.ts` — do not copy the whole module, a minimal
   spawn is fine) for a 2-thread smoke. This costs real money; keep it tiny. Do NOT run it
   yourself more than once to confirm it works.

## Deliverable

- The harness code + green default-scale test run.
- `docs/lhc/findings/concurrency.md`: what was tested, at what scales you ran it (run
  larger-than-default locally, e.g. 20 threads), numbers observed (drain latencies,
  starvation, loop lag), defects found (each with a minimal repro description), and a
  recommended global inference concurrency cap for the host. Be precise about what you did
  NOT test (process crash mid-drain, registry contention, etc.).

## Constraints

- Do NOT modify the SDK repo. Do NOT touch anything outside `packages/lhc-host/` and
  `docs/lhc/findings/` in this repo. Do NOT `git commit` — leave the working tree for the
  orchestrator.
- `vp run typecheck` and `vp check` must pass at repo root when you finish; the default
  test must be green via the package test script.
- If you find a genuine SDK defect, do not work around it silently: document it in the
  findings with the repro, and make the harness assertion for it a clearly-marked
  `.fails`/skipped case referencing the findings doc.

## Report back

Findings summary, commands run + results, any deviations and why.
