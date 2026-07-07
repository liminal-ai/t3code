# Verification task: audit Slice 2.1 rebuilder port (read-only)

Read-only: no file changes, no commits, no paid calls. Package tests were reported green
by the implementer (44 passed); your sandbox may block test runs — if so, audit statically
and say so.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-2.1.md`.
Under audit: uncommitted diff in `packages/lhc-host/src/claude-swap/` + fixtures.
Originals (read-only): `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/cc-lhc/src/rollout/{types,rebuild,write-rebuilt}.ts`, `test/rollout/`.
Ground truth for the resume contract: `docs/lhc/findings/claude-swap.md` (mandatory line
shapes, session-id/filename/parent-chain invariants, realpath encoding gotcha).

## Check

1. **Diff every ported file against its original.** Allowed: import paths, namespace node
   imports, effect-diagnostics pragmas, vite-plus/test, `claudeProjectsDir`
   parameterization, realpath resolution, sessions-index removal, inlined helpers
   (`encodeProjectPath`, `writeRolloutFileFsync`, `rolloutPathForSession` — diff these
   against their cc-lhc origins too). ANY behavioral drift in line construction, parent
   chains, envelope handling, or fsync semantics is a finding.
2. **Resume-contract conformance.** Cross-check the rebuilt output (from the tests/
   fixtures) against the claude-swap findings' mandatory requirements: sessionId ==
   filename uuid, fresh parent chain from `parentUuid: null`, envelope scalars, plain-
   string user content, synthetic assistant ids. Would a file produced by this port have
   passed the 0.3 probe?
3. **The sessions-index strip.** Confirm nothing left half-referenced; confirm the swap
   receipt behavior (trailing runtime-note line) survived the strip intact.
4. **realpath encoding.** Encoding happens from the resolved realpath in both the path
   derivation AND the envelope cwd (consistency between the two — a mismatch would break
   Claude's project-dir association).
5. **The new integration test.** Does it exercise a REAL `getSessionThreadView` (real SDK,
   real intake) rather than a hand-built view object, and are its assertions the
   invariants from the findings doc (not just "file exists")?
6. **`RebuildRolloutInput` seam.** Unchanged shape vs cc-lhc (standing decision: future
   codex rebuilder mirrors it).

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, file/line specifics.
