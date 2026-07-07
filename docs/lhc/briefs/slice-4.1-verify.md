# Verification task: audit Slice 4.1 codex rebuilder port (read-only)

Read-only: no file changes, no commits, no paid calls. If the sandbox blocks test runs,
audit statically and say so.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-4.1.md`.
Under audit: uncommitted diff in `packages/lhc-host/src/codex-swap/`.
Originals (read-only): `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/codex-lhc/src/rollout/`, `test/rollout/`, `docs/codex-rollout-format-report.md`.
Resume-contract ground truth: `docs/lhc/findings/codex-swap.md`.

## Check

1. **Diff every ported file vs original.** Allowed categories only (imports, namespace
   node imports, pragmas, vite-plus/test, codexHome parameterization, id-guard,
   .ts extensions). ANY drift in line construction, session_meta shape, fabricated
   exchange format, timestamp/path derivation, or fsync semantics is a finding.
2. **The id-guard.** `assertRolloutIdentityInvariant`: does the filename-suffix regex
   handle the actual filename format (`rollout-<ISO-ts>-<uuid>.jsonl` — check against
   real fixture names and the probe's observed paths)? Guard covers all three ids
   (filename, payload.id, payload.session_id)? Throws before any bytes hit disk?
3. **Resume-contract conformance.** Would output pass the codex-swap.md invariants:
   valid session_meta first line, clean JSONL throughout, path convention
   `sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` with date dirs derived from the same
   timestamp as the filename?
4. **Seam parity.** `WriteRebuiltRolloutInput` surface genuinely parallel to the Claude
   port's (required root param, same optional-receipt idea)? The removed homedir()
   fallback complete (no residual default-home path)?
5. **New integration test** — real SDK + real getSessionThreadView (not hand-built),
   assertions match the findings-doc invariants?

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, file/line specifics.
