# LHC multi-thread drain concurrency findings

Date: 2026-07-07

## Scope

This slice added a host-side validation harness in `packages/lhc-host/test/concurrency/` for one background-mode LHC SDK instance driving many thread files concurrently. The harness uses the direct `inferenceCallbacks` construction path, temp-dir storage, concurrent Promise-level intake, background drains, `drainSettled`, `inspect.health`, raw queue sampling, and a 50 ms heartbeat for event-loop lag.

Evidence from the SDK design/source:

- Direct callbacks are an explicit `initLhc` construction path and are validated by operation name before use: `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/sdk.ts:497`.
- The design intent is one durable queue per thread SQLite file, one work item at a time per thread, retry with exponential backoff, and per-thread ordered work: `/Users/leemoore/code/pi-long-horizon/liminal-context/docs/onboard/02-domain-design.md:15`.
- The scheduler is intentionally per-thread single-flight with pending coalescing and backoff wake timers: `/Users/leemoore/code/pi-long-horizon/liminal-context/docs/onboard/02-domain-design.md:25`, `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:444`, `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:474`, `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/scheduler.ts:508`.
- Work claiming is head-first and does not skip around a backed-off or in-flight head inside a thread: `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/work-queue/index.ts:426`.
- Completion is fenced by claim epoch and source version before deleting the work item: `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/shared-tech/work-queue/index.ts:484`.

## Harness coverage

The harness creates N threads under a single registry, then interleaves realistic batches per thread:

- `user_prompt`
- `assistant_thinking`
- `assistant_text`
- `tool_call`
- `tool_result`
- `turn_end`

Each turn is split into two intake batches to exercise post-commit pokes while other threads are still writing. Per thread, turns are ordered. Across threads, intake and drains run concurrently.

Measured:

- Time from each `turn_end` intake completion to that thread's `drainSettled` resolution.
- Max staleness of the oldest live queued/claimed work item seen by raw SQLite polling.
- `inspect.health` counts after quiesce.
- Max event-loop heartbeat lag using a 50 ms timer.
- Simulated inference calls, injected retryable failures, and max concurrent callback executions.

Asserted:

- Expected event/message/turn counts per thread.
- Spot-check that message contents contain only that thread's markers.
- No leftover queued/claimed derivation work after quiesce.
- No failed or blocked derivations in zero-failure and retryable-failure scenarios.

Knobs:

- `LHC_LOAD_THREADS`, default `10`.
- `LHC_LOAD_TURNS`, default `3`.
- `LHC_LOAD_DELAY_BASE_MS`, default `80`.
- `LHC_LOAD_DELAY_JITTER_MS`, default `120`.
- `LHC_LOAD_FAILURE_RATE`, default `0`.
- `LHC_LOAD_REAL_INFERENCE=1` enables the tiny real `claude -p` smoke only for the gated test or standalone runner. Simulated tests explicitly pin `realInference: false` so this env var cannot turn the default suite into paid calls.
- `LHC_LOAD_CLAUDE_MODEL`, default `haiku`, selects the model passed to `claude -p --model`.
- `LHC_LOAD_REAL_TIMEOUT_MS`, default `180000`, is the per-call real-inference timeout.

## Results

Default package test:

```text
pnpm exec vp run --filter @t3tools/lhc-host test
2 files passed, 3 tests passed, 1 skipped
Duration: 3.30s
```

Standalone default, 10 threads x 3 turns, 80-200 ms simulated callbacks, no injected failures:

```text
wall: 1360 ms
drain latency: count 30, min 684, p50 844, p95 931, max 950, avg 836 ms
oldest queued staleness max: 528 ms
event-loop max lag: 272 ms
inference calls: 60
max concurrent inference callbacks: 10
health: ready 150, pending 0, retrying 0, failed 0, blocked 0, queue 0/0
```

Larger run, 20 threads x 3 turns, 80-200 ms simulated callbacks, no injected failures:

```text
wall: 1492 ms
drain latency: count 60, min 633, p50 787, p95 917, max 944, avg 793 ms
oldest queued staleness max: 526 ms
event-loop max lag: 333 ms
inference calls: 120
max concurrent inference callbacks: 20
health: ready 300, pending 0, retrying 0, failed 0, blocked 0, queue 0/0
```

Default scale with 20% first-attempt retryable failures:

```text
wall: 1650 ms
drain latency: count 30, min 689, p50 978, p95 1200, max 1232, avg 1007 ms
oldest queued staleness max: 720 ms
event-loop max lag: 270 ms
inference calls: 69
injected retryable failures: 9
max concurrent inference callbacks: 10
health: ready 150, pending 0, retrying 0, failed 0, blocked 0, queue 0/0
```

Larger latency envelope, 20 threads x 3 turns, 300-1500 ms simulated callbacks, no injected failures:

```text
wall: 7716 ms
drain latency: count 60, min 3772, p50 5169, p95 6590, max 7182, avg 5352 ms
oldest queued staleness max: 4186 ms
event-loop max lag: 329 ms
inference calls: 120
max concurrent inference callbacks: 20
health: ready 300, pending 0, retrying 0, failed 0, blocked 0, queue 0/0
```

Verifier real-inference standalone smoke, before the revision:

```text
LHC_LOAD_REAL_INFERENCE=1 node --experimental-strip-types packages/lhc-host/test/concurrency/run-load.ts
scale: 2 threads x 1 turn
wall: about 126s
real claude -p calls: 5 total, 4 unique plus 1 retry
observed issue: one call exceeded the original 60s per-call timeout, was SIGKILLed, then retried
health: all 10 derivations ready, queue empty
```

Revision confirmation run, after raising the timeout and defaulting real calls to `--model haiku`:

```text
LHC_LOAD_REAL_INFERENCE=1 pnpm exec vp test run test/concurrency/concurrency.test.ts
1 file passed, 3 tests passed
Duration: 46.58s
scale: real smoke stayed at 2 threads x 1 turn
timeout observation: total test duration was below the new 180s per-call timeout, so the previous 60s timeout/SIGKILL path did not recur
```

## Findings

No SDK correctness defect was reproduced at these scales.

All tested runs preserved per-thread record integrity, showed no cross-thread message contamination, drained to queue-empty, and ended with `inspect.health` reporting no pending/retrying/failed/blocked derivations. The retryable-failure scenario injected 9 callback failures and still quiesced all threads, so retry/backoff did not wedge other thread drains.

The real-inference path also works at the tiny smoke scale. The verifier's standalone run proved the callbacks could drive real `claude -p` to quiescence, but also exposed that 60s was too close to normal CLI latency and made the gated Vitest smoke red-to-flaky. The revised smoke uses a 180s per-call timeout, a 600s Vitest budget, retry budget 2, and `--model haiku` by default; the one authorized confirmation run passed in 46.58s.

The most important operational finding is that the SDK scheduler limits work per thread, not globally. In the 20-thread runs, max concurrent inference callbacks reached 20. That matches the per-thread design: each thread can have one active drain, and each drain can be inside an inference callback. There is no host-wide model-call limiter in this layer.

Recommendation: put a host-level inference concurrency cap around the callbacks. Start at `8` for local/subprocess inference and real provider calls, with telemetry for queue staleness, event-loop lag, provider rate limits, and user-visible drain latency. The evidence here says 20 concurrent simulated callbacks can complete correctly, but it also shows max active inference scales directly with thread count and can produce 270-333 ms heartbeat lag in this Node process. A cap of 8 keeps background drains useful while avoiding surprise 20+ subprocess/API bursts as thread count grows.

## Defects

None found in this slice. No `.fails` harness case was added.

## Not tested

- Process crash or kill mid-drain, mid-completion, or during retry backoff.
- Multiple SDK instances in the same process competing over the same thread files.
- Cross-process concurrency against the same thread SQLite file.
- Registry contention under concurrent create/list/resolve workloads beyond initial thread creation.
- Real `claude -p` inference beyond the 2-thread x 1-turn smoke. I did not run larger paid real-inference scenarios.
- Long soak runs, hundreds of threads, or high-turn-count workloads.
- Non-retryable failures and retry-budget exhaustion as an expected terminal state.
- Native mobile code paths.
