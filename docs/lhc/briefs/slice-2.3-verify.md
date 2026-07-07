# Verification task: audit Slice 2.3 auto-compact suppression (read-only)

Read-only: no file changes, no commits, no paid calls. If the sandbox blocks test runs,
audit statically and say so.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-2.3.md`.
Under audit: uncommitted diff — `apps/server/src/provider/Layers/ClaudeAdapter.ts` (+ its
test), `packages/lhc-host/src/config.ts` (+ config.test.ts).

## Check

1. **Mechanism validity.** The implementer chose SDK `options.settings.autoCompactEnabled:
false` (inline settings = flag-settings layer, highest user-controlled priority).
   Verify against `node_modules/@anthropic-ai/claude-agent-sdk` types/docs: does inline
   `settings` actually override user/project `settingSources` for this field? Is
   `autoCompactEnabled` the real field name in the `Settings` type? Any risk the merge
   clobbers other settings the adapter already passes (read the merge site — is it a
   spread that preserves existing keys, and does order matter)?
2. **Flag semantics.** `isAutoCompactSuppressionEnabled()`: default ON when capture
   enabled; forced OFF under `T3CODE_LHC_DISABLE=1`; opt-out `=0`/`false`. Check the
   interaction matrix is actually implemented as reported (including
   `T3CODE_LHC_NO_INFERENCE` — should NOT disable suppression; capture still owns
   context). Any import-cycle or layering smell in how ClaudeAdapter consumes the helper
   (it must not pull capture internals into the adapter)?
3. **Test honesty.** Do the adapter tests assert the constructed query options (the real
   seam) rather than the helper's return value? Is default-on behavior asserted, and were
   pre-existing settings assertions updated legitimately (not weakened to make the new
   default pass)?
4. **Blast radius.** With suppression default-ON, every Claude session in this fork now
   gets inline settings injected — including sessions on threads where LHC capture might
   be disabled per-thread in the future. Acceptable today (capture is global), but check:
   if `T3CODE_LHC_DISABLE=1`, is the settings object genuinely ABSENT (bit-identical
   behavior to upstream), not just `autoCompactEnabled` omitted?
5. **Containment.** Diff limited to the four files; the slice-2.3 marker comment present;
   no other adapter behavior touched.

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, file/line specifics.
