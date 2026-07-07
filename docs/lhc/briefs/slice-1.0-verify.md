# Verification task: audit Slice 1.0 ClaudeAdapter fidelity patch (read-only)

Read-only: no file changes, no commits, no paid provider calls (do NOT run the probe).
You may run the ClaudeAdapter test file and read-only shell commands.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-1.0.md`.
Under audit: the uncommitted diff (`git status` / `git diff`) — primarily
`apps/server/src/provider/Layers/ClaudeAdapter.ts`, its test file, the probe script,
`packages/lhc-host/test/fixtures/event-fidelity/claude/post-patch/`, and the amended
`docs/lhc/findings/event-fidelity.md`.

## Check

1. **Patch 1 correctness.** Read `resolvePersistedToolOutput` and its call site: does the
   sidecar read genuinely never throw into the event pipeline (verify the
   `Effect.orElseSucceed` path covers open/read/decode failures)? Is the 10 MB cap
   enforced on BOTH reported size and actual read length? Is `fullOutput` only on
   `item.completed` (updated keeps preview)? Could a malicious/odd `persistedOutputPath`
   escape intended scope (path traversal — does it trust the SDK-provided path blindly,
   and is that acceptable given it comes from Claude Code's own sidecar metadata? state a
   view)?
2. **Patch 2 correctness.** The reasoning fix reuses assistant-text block machinery with a
   `kind` discriminator. Audit for regressions: can a reasoning block ever leak into
   assistant_message paths (the snapshot backfill filter — is filtering to
   `assistant_message` blocks sufficient everywhere positional matching happens)? Bare
   `thinking_delta` without `content_block_start` — handled? Interleaved
   thinking/text/tool blocks in one message — do lifecycles stay correctly paired?
3. **Tests.** Run the ClaudeAdapter test file; confirm 62/62 including the 3 new tests,
   and read the new tests: do they assert the actual behaviors (sidecar read fallback,
   cap, reasoning lifecycle) or happy paths only? Name missing cases if material.
4. **Fixtures.** Post-patch fixtures: does line 20's completed command item show
   `fullOutputSize: 108894` with consistent trim markers? Reasoning pairs at the cited
   lines? Pre-patch fixtures untouched (git diff should show no changes there)?
5. **Findings doc.** Post-patch amendments clearly marked, pre-patch record intact,
   tap-point section now consistent with the patched reality?
6. **Diff containment.** Nothing changed outside: ClaudeAdapter.ts, its tests, the probe
   script, post-patch fixtures, findings doc.

## Report

Verdict per item, overall ACCEPT or REVISE-with-findings, file/line specifics.
