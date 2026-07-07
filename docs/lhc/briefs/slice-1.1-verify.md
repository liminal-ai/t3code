# Verification task: audit Slice 1.1 mapper + turn accumulator (verify, don't fix)

No file modifications, no commits. You may run the package tests and read-only shell.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-1.1.md` (read fully —
it contains the design rulings the implementation must honor).
Under audit: `packages/lhc-host/src/intake/` (mapper.ts, turn-accumulator.ts, stats.ts,
mapper.test.ts) + `packages/lhc-host/test/fixtures/intake/`.
Ground truth: `docs/lhc/findings/event-fidelity.md` and the real fixtures under
`packages/lhc-host/test/fixtures/event-fidelity/`.
LHC intake contract (read-only):
`/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc/src/intake-stream/index.ts`
and `docs/onboard/02-domain-design.md` (intake stream section) in that repo.

## Check

1. **The dedupe linchpin.** The stream-derived `user_prompt` (Codex `user_message` items)
   and the host-injected `userPromptEvent(...)` MUST produce byte-identical idempotency
   keys for the same (threadId, turnId). Verify by reading both code paths AND by test
   evidence. If any turn can produce a stream user_message with a turnId the host
   injection wouldn't have (or vice versa), name it.
2. **Mapping fidelity vs findings.** For each row of the findings tables (post-patch
   Claude + Codex): does the mapper read the field the findings say holds full content
   (Claude `data.result.fullOutput` w/ preview+marker fallback; Codex
   `data.item.aggregatedOutput`; `payload.detail` for text/thinking)? Spot-check against
   the real fixtures by running the tests and reading the snapshots — do tool_result
   contents in the mapped output actually contain the full output (not the preview) for
   the large-output turns?
3. **Structural typing decision.** The implementer mirrored the provider-event/tool-item
   vocabulary locally instead of importing `@t3tools/contracts` (to avoid a package.json
   change). Assess: is the structural typing safe against contract drift (what happens
   silently if `providerRuntime.ts` renames a field?), and should this be a REVISE
   (import the contracts package — it's an in-repo workspace dep, cheap) or an accepted
   tradeoff? Give a reasoned ruling, not just a preference.
4. **Turn accumulator contract.** Fold-only, no timers; turn_end exactly on
   turn.completed/aborted; no synthesized turn_ends on turn.started; open turn at
   process end is legal; interrupted/failed → runtime_note BEFORE turn_end (order matters
   for the LHC record). Check the LHC contract doc's rules (one open turn; user_prompt
   closes-and-opens) are not violated by any emission order the mapper can produce.
5. **Tolerance.** Feed-forward: unknown item type, unknown event type, malformed payload
   fixtures — skip/malformed counters, never throw. `content.delta` ignored WITHOUT
   counting. `context_compaction` → runtime_note + counted.
6. **Replay-twice integrity.** The integration test must prove zero-duplicates via the
   REAL SDK's per-event recorded/skipped results (or record counts), not via mapper-side
   bookkeeping. Run the tests; confirm `{open:1, closed:3}` / `{open:1, closed:2}` claims.
7. **Key stability.** Keys contain nothing non-deterministic (timestamps, indices that
   shift across re-tails). Would a re-tail after restart (same fixtures) produce identical
   keys? That's the crash-recovery story.

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, file/line specifics, and your
ruling on item 3 stated explicitly.
