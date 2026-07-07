# Task: capture service, lineage, and server wiring (Slice 1.2)

You are in a t3code fork. Build the capture service that ties together what previous
slices produced — the mapper (`packages/lhc-host/src/intake/`), the inference lane
(`packages/lhc-host/src/inference/`) — and wire it into the server so every Claude and
Codex thread is recorded into a durable LHC thread as it runs. This is the first slice
that touches server bootstrap; the wiring diff in `apps/server` must stay minimal and
contained (target: ≤2 files touched there).

## Required reading

1. `docs/lhc/implementation-plan.md` — Slice 1.2 + standing decisions (state layout,
   scope: Claude+Codex only).
2. `docs/lhc/impl-log.md` — the rulings log, especially host-side user-prompt injection
   keyed by turnId.
3. `packages/lhc-host/src/intake/mapper.ts` — `userPromptEvent(...)`, `mapProviderEvent`,
   stats shapes. `src/inference/claude-cli.ts` + `assignments.ts` — the ModelCall provider.
4. In `/Users/leemoore/code/pi-long-horizon/liminal-context` (read-only):
   `packages/lhc/src/sdk.ts` (initLhc config: mode, inference XOR inferenceCallbacks,
   drainSettled), `packages/cc-lhc/src/intake/session.ts` (a host's capture-session
   lifecycle: construction, stop with capped drain-settle, stats carry),
   `packages/cc-lhc/src/intake/paths.ts` (state-dir pattern).
5. `apps/server/src/provider/ProviderDriver.ts` (ProviderInstance: driverKind, adapter),
   `provider/Services/ProviderInstanceRegistry.ts` + `Layers/ProviderInstanceRegistryLive.ts`
   (how instances are registered/looked up), `provider/Services/ProviderService.ts` +
   `Layers/ProviderService.ts` (where sendTurn routes and what it returns),
   `apps/server/src/serverLayers.ts` / `bootstrap.ts` (where long-lived services start).

## What to build (all in `packages/lhc-host/src/` unless stated)

### 1. Paths + config (`src/paths.ts`, `src/config.ts`)

State root `~/.t3code-lhc/` (override `T3CODE_LHC_HOME`): `registry.sqlite` (LHC thread
registry), `t3code-lhc.sqlite` (lineage), `threads/<uuid>.sqlite`. mkdir recursive on
startup (SQLite won't create parents). Env: `T3CODE_LHC_NO_INFERENCE=1` → manual-mode SDK
with `createDeterministicInferenceCallbacks` (capture still runs, no model calls, skip
drain-settle waits) — cc-lhc pattern. `T3CODE_LHC_DISABLE=1` → the whole service is a
no-op (belt-and-braces kill switch).

### 2. Lineage (`src/lineage.ts`)

SQLite table mapping t3 `ThreadId` → LHC thread id (+ createdAt, providerKind). API:
`getOrCreate(t3ThreadId, meta)` — resolves existing or creates a new LHC thread (via
`sdk.threads` with file under `threads/`, title from meta if available) and records the
row atomically (file-then-row order; a crash between leaves an orphan thread file, which
is harmless — cc-lhc lineage-db is the pattern). Use `node:sqlite` or whatever the linked
`lhc` package uses internally — do NOT add a new sqlite dependency without checking what's
already available.

### 3. Capture service (`src/capture/service.ts`)

- One long-lived SDK instance: `initLhc({ mode: "background", inference: { call:
<claude-cli ModelCall>, assignments } , ...})` (or manual+deterministic per env). Thread
  registry path from paths.ts — check how `sdk.threads.newThread`/registry wiring works in
  the linked SDK and set it up accordingly.
- Subscribe to `adapter.streamEvents` for every provider instance whose `driverKind` is
  `codex` or `claudeAgent` — enumerate current instances AND handle instances
  (re)registered later if the registry exposes changes; if it doesn't, subscribe at
  first-use via the sendTurn tap and document the limitation.
- Route events by `threadId` into a per-thread FIFO worker (look at
  `@t3tools/shared/DrainableWorker` — reuse it if it fits; per-thread serialization is a
  hard requirement, cross-thread concurrency is fine). Worker body: fold turn accumulator,
  map event, and if events non-empty call `sdk.intakeStream.messageEvents(threadRef,
events)`. Intake failures: log via `sdk.logging` (fail-soft) + stats counter — capture
  must NEVER propagate errors into the server's event path.
- **User-prompt injection:** observe successful `sendTurn` calls (thread id, returned
  turnId, prompt text) and enqueue `userPromptEvent(...)` through the same per-thread
  worker BEFORE any stream events for that turn get processed... which cannot be
  guaranteed by timing — rely on LHC's turn machine instead: user_prompt with an
  already-open empty turn simply joins it; stream user_message (Codex) dedupes by key
  either way. Just enqueue on sendTurn success.
- Stats: aggregate per thread + global (mapper stats + intake result counts), exposed on
  the service handle for later endpoint slices.
- Shutdown: stop accepting, drain workers, `drainSettled` per touched thread capped at
  30s total, `killAllInferenceChildren()`. Idempotent.

### 4. Server wiring (`apps/server` — the contained diff)

An Effect Layer in `lhc-host` (e.g. `src/server-layer.ts`) that the server composes.
Find the right place in `serverLayers.ts`/`bootstrap.ts` to (a) start the service after
the provider registry is up, (b) tap sendTurn — prefer wrapping/observing at ONE choke
point (e.g. where ProviderService routes sendTurn) rather than per-adapter changes,
(c) register shutdown. If tapping sendTurn cleanly requires touching ProviderService
itself, a ≤10-line observation hook there is acceptable — name it clearly (e.g.
`onTurnStarted` callback registration) rather than importing lhc-host types into
provider code.

## Tests (hermetic — no real providers, no real model calls)

- Scripted fake adapter stream (build `ProviderRuntimeEvent` objects) driving the
  service against a real SDK instance in a temp dir (deterministic callbacks): assert
  record contents via `inspect.overview`/`messages.list`, per-thread ordering under
  concurrent multi-thread emission, sendTurn-injection dedupe against a stream
  user_message with the same turnId.
- Lineage: getOrCreate idempotency, concurrent getOrCreate for the same thread races to
  one row.
- Shutdown: pending queued events flushed, drainSettled awaited (manual-mode path can
  skip), second stop() is a no-op.
- Failure injection: intake rejection (feed a deliberately contract-violating batch) →
  stats counter + no throw.

## Acceptance

- Package tests green; `vp run typecheck` + `vp check` green at root.
- `apps/server` diff ≤2 files, reviewable in isolation, no lhc-host type leakage into
  provider modules beyond the named hook.
- Server still boots: `pnpm exec vp run --filter t3 test` is too heavy — instead run the
  server's own test suite for the touched files if one exists, and report; live boot
  validation is Slice 1.3's job.
- No `git commit`.

## Report back

The wiring diff (files + line counts), how the sendTurn tap works, instance-subscription
approach (registry-driven or first-use), stats surface shape, test results, deviations.
