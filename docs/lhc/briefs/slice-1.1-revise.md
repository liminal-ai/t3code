# Revision request: Slice 1.1 mapper (verifier findings)

Your mapper was verified: ACCEPT overall — dedupe linchpin, mapping fidelity, tolerance,
replay-twice integrity, and key stability all PASS. Five findings to address in one pass
(none change the design):

1. **Contracts import (the one required change).** Add `@t3tools/contracts` as a workspace
   dependency of `lhc-host` and import `TOOL_LIFECYCLE_ITEM_TYPES` +
   `isToolLifecycleItemType` from it, deleting the mirrored array at `mapper.ts:7-15`.
   Rationale (verifier's): it's a runtime value — if contracts adds an eighth tool type,
   the mirror silently downgrades that tool from captured to skipped, which is invisible
   capture loss. Keep ALL runtime structural payload validation exactly as-is (that part
   was ruled correct); optionally `import type` payload/event types for documentation.
2. **Turn accumulator: simplify to a pure observer.** `foldTurnAccumulator` returns
   `emitTurnEnd: true` unconditionally, so `shouldEmitTurnEnd` always passes and the
   `if (!emitTurnEnd)` branches at `mapper.ts:262` and `287` are dead. Remove the pretend
   gate; keep the fold as an observable state/stats structure (a later slice may read
   open-turn state). Fix the related nits: state mutation happens before payload
   validation on `turn.completed` (`mapper.ts:107`) — validate first; and the identical
   if/else branches at `mapper.ts:113-117`.
3. **`context_compaction` coverage.** It's the only mapping-table row with zero test
   coverage. Add a synthetic fixture line and assert the runtime_note + counter.
4. **Counter specificity (small).** `user_message` without `turnId` currently lands in
   `malformed`; give it its own counter (e.g. `user_message_no_turn`) so the diagnosis is
   readable from stats.
5. **Document two known limits** where the code can't show them — as brief constraint
   comments at the relevant sites, stating the invariant not the history:
   (a) same-turnId second `user_message` collapses onto one key — key-wins dedupe drops
   its content by design; (b) `eventId`-based keys are stable across re-tails of the
   persisted stream only, not across hypothetical re-derivation from the provider.

Optional if cheap: in the replay test, directly assert pass-1 skipped count equals the
stream-derived user_prompt count (3 for Codex) to document the dedupe intent.

Constraints: changes in `packages/lhc-host/` only (the package.json dep line is in scope).
`vp run --filter @t3tools/lhc-host test`, `vp run typecheck`, `vp check` green. No commits.
Report the diff summary and test results.
