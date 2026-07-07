# Verification task: audit Slice 1.2a inference-lane port (read-only)

Read-only verification: no file changes, no commits. Read-only shell (diff, grep) fine.
Do NOT run real `claude -p`; the tests are hermetic and you may run the package test
script.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-1.2a.md`.
Under audit: `packages/lhc-host/src/inference/`, `packages/lhc-host/src/shared/claude-bin.ts`,
`packages/lhc-host/test/fixtures/fake-claude.mjs`.
Originals (read-only): `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/cc-lhc/src/inference/`,
`.../src/shared/claude-bin.ts`, `.../test/inference/`, `.../test/fixtures/fake-claude.mjs`.

## Check

1. **Diff every ported file against its original.** Confirm differences fall only into:
   import paths, env prefix (`CC_LHC_`→`T3CODE_LHC_`), concurrency default 3→8 (+comment),
   `vite-plus/test` imports, and the five toolchain adaptations the implementer disclosed
   (@effect-diagnostics pragmas, namespace node imports, ConcurrencyLimiter constructor
   expansion, oxfmt wraps, claude-bin.ts inclusion). Anything OUTSIDE those categories —
   especially any behavior change in failure classification, timeout/kill paths, child
   tracking, or the assignments' model/ratio values — is a finding.
2. **The constructor expansion** (ConcurrencyLimiter): confirm it's semantically identical
   to the parameter-property original (same initialization order, same field visibility).
3. **Test parity:** every test case in the cc-lhc originals exists in the port (count
   them); no assertions weakened; the fake binary's behavior matrix unchanged apart from
   env names.
4. **Run** `pnpm exec vp run --filter @t3tools/lhc-host test` — confirm green and that the
   inference tests actually executed (not skipped).
5. **Cap-8 comment:** states the constraint (host-level cap, cites concurrency findings)
   rather than narrating the change.

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, specifics with file/line.
