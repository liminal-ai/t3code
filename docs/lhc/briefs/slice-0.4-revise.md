# Revision request: Slice 0.4 concurrency harness (verifier findings)

Your harness was verified: design, concurrency claims, scheduler analysis, and measured
numbers all confirmed. Verdict was REVISE for four specific items. Context you need:

The verifier ran the flag-gated real-inference smoke you skipped. Result: the PATH works —
the same 2-thread × 1-turn scenario completed correctly via the standalone runner in
~126s (5 real `claude -p` calls: 4 unique + 1 retry after one call exceeded your 60s
per-call timeout and was SIGKILLed; all 10 derivations ready, queue empty). But the gated
VITEST smoke fails as written: real `claude -p` latency on these prompts runs 30-60s+, the
60s per-call timeout is marginal, and with retry budget a single slow item can consume far
more than the 180s test budget. Red-to-flaky whenever the flag is used.

## Required changes

1. Make the gated smoke pass when enabled: raise the per-call timeout and the test budget
   (and/or pass a faster model flag, e.g. `--model haiku`, on the `claude` invocation).
   Re-run it ONCE with `LHC_LOAD_REAL_INFERENCE=1` to confirm green — keep it to the
   2-thread minimal scale (paid calls, authorized for one confirmation run).
2. Paid-call footgun: `scenarioOptions` defaults `realInference` from the env var
   (`load-harness.ts:137`) and the two simulated tests don't pin it, so running the full
   suite with the env set would silently convert the 10×3 and failure-injection scenarios
   into ~60-90 paid calls (and the failure-injection test would fail — real callbacks
   ignore `failureRate`). Scope the env so it can only affect the gated smoke test:
   pass `realInference: false` explicitly in the simulated tests, or honor the env only
   inside the gated test.
3. Update `docs/lhc/findings/concurrency.md` with the real-smoke outcome (works standalone
   ~126s; one 60s-timeout retry observed; whatever your re-run shows after the fix).
4. Minor: the neighbor-marker contamination check at `load-harness.ts:597` resolves to
   `thread-(i+1)`, so the highest-indexed thread's negative check probes a marker that
   exists nowhere and passes vacuously. Wrap to thread 0.

Same constraints as before: no commits, nothing outside `packages/lhc-host/` and
`docs/lhc/findings/`, repo checks must stay green (`vp run typecheck`, `vp check`, default
package test). Report what changed and the re-run results.
