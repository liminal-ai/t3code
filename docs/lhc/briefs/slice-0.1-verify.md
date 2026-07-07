# Verification task: audit Slice 0.1 scaffold (read-only)

You are verifying another agent's work in this repo (a t3code fork). Do NOT modify any files.
Review the uncommitted working-tree changes (`git status` / `git diff` / read the new files
under `packages/lhc-host/`) against the acceptance criteria below. The implementer's brief is
at `/Users/leemoore/code/t3code-lhc/briefs/slice-0.1.md` — read it first.

## Acceptance criteria to audit

1. `packages/lhc-host/` is a well-formed workspace package following `packages/shared`
   conventions (package.json shape, tsconfig extends, script names, subpath exports, no
   barrel index).
2. The `lhc` dependency is a `link:` to
   `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc` with a correct
   relative path.
3. `src/sdk-smoke.test.ts` genuinely exercises the SDK: manual mode, deterministic callbacks,
   temp-dir-only storage (nothing under any home directory), real intake via
   `intakeStream.messageEvents`, read-back assertions, and a real idempotency re-send check
   (not a trivial always-true assertion). OpResult handling is explicit.
4. No changes outside `packages/lhc-host/` + `pnpm-lock.yaml` + the two pre-existing
   `docs/lhc/*.md` files (formatting-only churn there is acceptable).
5. Nothing in the external liminal-context repo was modified
   (`cd /Users/leemoore/code/pi-long-horizon/liminal-context && git status --short` should
   show only changes that predate this work: `pnpm-lock.yaml` modification and an untracked
   `packages/codex-lhc/` are pre-existing and fine).
6. Look for anything the implementer did that is subtly wrong or fragile: incorrect OpResult
   handling, test asserting the wrong thing, lockfile anomalies (e.g. registry entries that
   should be links), tsconfig drift from repo conventions.

## Report

A verdict per criterion (pass/fail/concern), then an overall verdict: ACCEPT or
REVISE-with-findings. Be specific — file and line for every finding. Do not fix anything.
