# Verification task: audit Slice 0.2 event-fidelity findings (STRICTLY READ-ONLY)

You are the verifier for another agent's investigation. You must not create, modify, or
delete any files, and must not `git commit`. Running read-only shell commands (jq, wc,
grep, node one-liners printing to stdout) is encouraged. If you catch yourself about to
write a file, stop — put everything in your final message instead.

The implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-0.2.md`.
The findings under audit: `docs/lhc/findings/event-fidelity.md`.
Fixtures: `packages/lhc-host/test/fixtures/event-fidelity/{claude,codex}/`.
Probe code: `packages/lhc-host/probes/`.

## What to check

1. **Claims vs fixtures.** Independently re-derive the headline claims from the fixture
   files: (a) Codex `item.completed` carries full `aggregatedOutput` (~108,894 bytes) for
   the seq-20000 turn; (b) Claude's completed tool payload is ~3KB vs the full output;
   (c) Claude user prompts produce NO completed `user_message` item in the normalized
   stream; (d) interrupts surface as `turn.completed` with interrupted/failed status, not
   `turn.aborted`. Use jq/wc on the fixtures — do the numbers and absences hold?
2. **Probe validity.** Read the probe script: does it construct the REAL adapters
   (`makeClaudeAdapter`/`makeCodexAdapter`) with real spawner/services, or could any part
   be inadvertently mocked/short-circuited such that the findings don't reflect production
   behavior? Were events captured from `adapter.streamEvents` (the same stream the server
   consumes)?
3. **Fixture integrity.** Trimming markers present where content was cut? Any place where
   trimming could have manufactured the truncation being claimed?
4. **Findings doc quality.** Every claim cited to fixture+line? Tap-point recommendation
   consistent with the evidence? Anything overclaimed (e.g. "Claude cannot" when only one
   size was tested — was a smaller tool output tested to find the truncation threshold, and
   if not, is that gap acknowledged)?
5. **The one thing that matters most downstream:** is the "Claude sidecar holds the full
   output" claim specific enough to act on (exact path/mechanism named), or does it need a
   follow-up probe?

## Report

Verdict per item (pass/fail/concern with evidence), overall ACCEPT or REVISE-with-findings.
Be specific: file, line, observed number vs claimed number.
