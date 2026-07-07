# Revision request: Slice 1.0 Patch 1 cap enforcement (verifier finding)

Verification verdict: Patch 2 (reasoning) ACCEPTED as-is. Patch 1 (fullOutput) has one
required fix:

**The 10 MB cap is not enforced on actual read length.** At ClaudeAdapter.ts ~2437-2440:
if `persistedOutputSize` is missing or under-reports, `readFileString` reads the entire
file into memory first, and the post-read check uses `fullOutput.length` (characters), not
bytes. Required: a hard BYTE cap on both reported size and actual size.

Fix (small, contained):

1. Before reading, `stat` the sidecar file via the same Effect `FileSystem` service and
   check its actual size against the cap — skip `fullOutput` (metadata only, using the
   stat size for `fullOutputSize` when the reported field is absent) if over.
2. Keep the reported-size pre-check as the cheap first gate.
3. After read, use `Buffer.byteLength(fullOutput, "utf8")` (or equivalent) for the
   belt-and-braces final check, not `.length`.
4. Stat/read failures degrade to metadata-only exactly like today — nothing throws into
   the event pipeline.
5. Extend the existing oversized-fallback test (ClaudeAdapter.test.ts ~998+) to cover the
   missing-`persistedOutputSize` + oversized-actual-file case.

Also record in the findings doc's post-patch section, one line: path traversal —
`persistedOutputPath` is trusted as Claude Code's own sidecar metadata (accepted risk,
local-only threat model).

Constraints: same as the original slice — diff stays in ClaudeAdapter.ts + its test file
(+ findings doc line). `vp run typecheck` green; run the ClaudeAdapter test file. No
commits. Report the diff summary and test results.
