# Task: Codex swap orchestration (Slice 4.2)

You are in a t3code fork. The Claude swap flow is done, live-proven, and hardened
(`packages/lhc-host/src/swap/claude.ts` — read it first; you are building its Codex
sibling). The codex resume mechanism is proven (`docs/lhc/findings/codex-swap.md` — the
recipe section is your contract), and the rebuilder is ported
(`src/codex-swap/write-rebuilt.ts`). Wire them together so `POST
/lhc/threads/:id/compact|prune` works on Codex threads too.

## Mandatory reading

1. `docs/lhc/findings/codex-swap.md` — full recipe + traps (bare `{threadId}` cursor;
   filename==meta-id invariant, guarded in the writer; missing-file error shape).
2. `packages/lhc-host/src/swap/claude.ts` + its tests — the structure, failure-safety
   invariants (flip-last, contested-flip guard, per-thread lock, busy check), error
   classification, and receipt shape you must mirror.
3. `docs/lhc/impl-log.md` (2.2 entries) — the Window A/B semantics; they apply
   identically.
4. Codex server internals: how CodexSessionRuntime/adapter resolve `CODEX_HOME` per
   instance, where the codex thread binding/cursor is persisted, how stopSession behaves,
   what `thread/resume` is passed on session start.

## Design constraints (rulings, not suggestions)

- **Extract, don't duplicate.** `swap/claude.ts` and the new codex flow share almost all
  structure (lineage resolve, busy check, lock, LHC op, view render, quiesce, rebuild,
  flip, contested guard, receipt). Refactor the shared skeleton into a provider-agnostic
  core (`swap/core.ts` or similar) with injected provider strategy (paths+home
  resolution, rebuild call, cursor read/write shape, flip verification) — the AGENTS.md
  duplicate-logic rule applies. Claude behavior must not change: its tests must pass
  UNMODIFIED except import paths (any assertion change = you broke behavior; stop and
  reconsider).
- **Codex cursor flip**: per the findings, the persisted cursor is `{ threadId:
<rolloutSessionId> }` — the flip writes the NEW synthetic session id as the thread
  binding's codex thread id, via the same session-directory upsert mechanism (verify
  merge semantics like 2.2 did). The contested-flip guard applies identically (a mid-swap
  sendTurn would revive on the old id).
- **Same endpoints**: the HTTP layer routes by the thread's provider (lineage row has
  providerKind); `not_claude` disappears as an error — replace with
  `unsupported_provider` for anything not claudeAgent/codex. Update mapping + tests.
- Busy check / quiesce / receipt / runtime-note: identical semantics via the shared core.

## Tests

- The shared-core refactor proves itself: existing Claude swap tests green UNMODIFIED
  (imports aside).
- Codex strategy: mirror the Claude orchestrator test set (happy-path ordering with
  flip-last, failure-at-each-step cursor-untouched, contested flip, lock, busy) using a
  fake codex provider, plus an integration test: real SDK compact → real
  `codex-swap/write-rebuilt` into a temp CODEX_HOME → receipt + file invariants
  (including the id-guard passing).
- Endpoint: codex thread routes through; `unsupported_provider` mapping test.

## Acceptance

- Full lhc-host suite green; any touched server suites green; `vp run typecheck` +
  `vp check` green at root.
- No Claude behavior change (test-diff review will be strict on this).
- Server diff: ideally zero new server files; if codex home/cursor resolution needs a
  helper like ClaudeSwapHome.ts, mirror that pattern, contained.
- No `git commit`.

## Report back

The core/strategy split (what's shared vs injected), codex cursor flip mechanism found,
server diff, test results, deviations, open risks for the 4.3 live acceptance.
