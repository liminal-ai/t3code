# Verification task: audit Slice 0.3 Claude swap-recipe findings (read-only)

You are the verifier for another agent's investigation. Read-only: do not create, modify,
or delete files; no `git commit`. Read-only shell commands (jq, wc, grep, ls into
`~/.claude/projects/`) are fine. Do NOT run the probe (it makes paid provider calls) —
audit from artifacts.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-0.3.md`.
Under audit: `docs/lhc/findings/claude-swap.md`,
`packages/lhc-host/probes/claude-swap-probe.ts`,
`packages/lhc-host/test/fixtures/claude-swap/`.
Reference (read-only): `apps/server/src/provider/Layers/ClaudeAdapter.ts` (resume cursor
handling ~line 562+), and in `/Users/leemoore/code/pi-long-horizon/liminal-context`:
`packages/cc-lhc/src/rollout/rebuild.ts` / `write-rebuilt.ts` (the rollout shape the
rebuilt file was modeled on).

## What to check

1. **Probe validity.** Does the probe drive the REAL `makeClaudeAdapter` (same construction
   as the event-fidelity probe), and does the "swap" step genuinely start a fresh session
   whose ONLY link to the past is `resumeCursor: { resume: <newSessionId> }`? Look for any
   accidental leakage that could explain the recall (e.g. same in-memory adapter instance
   carrying state, cwd reuse letting claude `--continue` semantics kick in, the planted
   fact appearing in the prompt).
2. **The headline claim.** From the fixtures: does the recorded swap-session answer say
   BRONZE-HERON-77 (the rebuilt-file-only fact) and is AZURE-FALCON-42 absent from the
   rebuilt file handed to the session? Is the rebuilt rollout's before/after line growth
   (4 → 14) evidenced?
3. **The rebuilt-file shape.** Compare the fixture rebuilt rollout against the cc-lhc
   rebuild shapes: is what the findings call "the cc-lhc minimal shape" actually that, and
   are the named mandatory envelope fields (`sessionId` = filename uuid, fresh
   parent-chain, envelope scalars) consistent with what the file shows?
4. **Failure-mode claims.** Ghost-uuid: findings say startSession succeeds and the FIRST
   TURN fails with "No conversation found with session ID". Non-uuid cursor: silently
   dropped at `readClaudeResumeState` → fresh session. Verify the second claim directly
   against the adapter source (it's a code-reading claim). Is the recommended mitigation
   (pre-validate uuid + file existence before flipping) sound and sufficient, or is there
   a race it doesn't cover (file deleted between check and start; reaper revival)?
5. **Recipe completeness for Slice 2.2.** If you followed only `claude-swap.md`, could you
   implement the server-level swap without re-deriving anything? Name what's missing, if
   anything (e.g. exact `resume_cursor_json` shape in the persistence row vs the adapter
   input shape; whether `resumeSessionAt` must be cleared on flip).

## Report

Verdict per item (pass/fail/concern with file/line evidence), overall ACCEPT or
REVISE-with-findings.
