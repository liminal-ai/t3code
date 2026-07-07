# Verification task: audit Slice 3.1 (read-only)

Read-only: no file changes, no commits, no paid calls. If the sandbox blocks test runs,
audit statically and say so.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-3.1.md`.
Under audit: uncommitted diff — `packages/lhc-host/src/swap/claude.ts` (endpoint
additions), `src/swap/claude.test.ts` (new tests), `docs/lhc/operations.md` (new).

## Check

1. **Ops doc accuracy (highest value).** Line-by-line cross-check of
   `docs/lhc/operations.md` against the actual code: every env flag name and semantics
   vs `packages/lhc-host/src/flags.ts` + `config.ts`; every endpoint path/method/response
   field vs `http.ts` + `swap/claude.ts`; error codes vs the classifier; boot recipe vs
   `docs/lhc/findings/live-capture-validation.md`; state layout vs `paths.ts`;
   troubleshooting claims vs the findings docs they cite. Flag ANY aspirational or stale
   statement — this doc is the operator's ground truth.
2. **Endpoint additions.** Genuinely additive (no renamed/removed fields)? `tailTokens`/
   `compactRecommended` mirrors consistent with `viewStatus` source? Stats merge for
   `pending`/`pendingHigh` correct per-thread (keyed correctly, no cross-thread mixup)?
3. **swap_in_progress test.** Does the gate genuinely park the FIRST swap inside quiesce
   while the second request races (not sequenced), and does the release path prove the
   first completes successfully? `stepReached: busy-check` the right assertion?
4. **Suppression already-covered claim.** Confirm ClaudeAdapter.test.ts:688-763 does
   assert `createInput.options.settings.autoCompactEnabled` through the real
   startSession path — is the implementer's "no duplicate needed" call right?
5. **viewStatus integration assertions** — real SDK, meaningful values (not vacuous
   `>= 0`-style)?

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, file/line specifics.
