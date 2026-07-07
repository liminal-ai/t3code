# Task: Claude session-swap recipe probe (Slice 0.3)

You are in a t3code fork. Goal: produce a **verified, step-by-step recipe** for swapping a
t3code-managed Claude session onto a _rebuilt_ rollout file — the mechanism a later slice
will use to make compaction take effect. This is an investigation with a findings doc as
the deliverable. Do NOT modify `apps/server` or `packages/contracts` (read-only). Do NOT
`git commit`.

## Background (read first)

- `packages/lhc-host/probes/event-fidelity-probe.ts` in this repo — a working harness from
  the previous probe that constructs the REAL `makeClaudeAdapter` and drives
  startSession/sendTurn/stopSession. Reuse its construction pattern.
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` — especially `readClaudeResumeState`
  (~line 562: the exact resume-cursor shape `{ resume: <uuid>, resumeSessionAt?: <uuid> }`),
  how `startSession` consumes `input.resumeCursor`, and how the resume cursor is updated
  from session events.
- Read-only, in `/Users/leemoore/code/pi-long-horizon/liminal-context`:
  `packages/cc-lhc/src/rollout/rebuild.ts` and `write-rebuilt.ts` — proven rebuilt-rollout
  line shapes for Claude Code (user/assistant JSONL lines, parent-uuid chain, envelope).
  Also `rollout/sessions-index.ts` for what the sessions index is.

## The experiment

All sessions in a FRESH temp git repo as cwd (never a real project). Cheap model if easy to
select; short prompts. Budget ≤5 provider sessions total.

1. **Baseline session.** Start a Claude session via the real adapter; turn 1 plants a
   memorable fact ("The deployment codename is AZURE-FALCON-42"). Capture the resume cursor
   the adapter reports (from `ProviderSession` / session events). Stop the session. Locate
   its rollout: `~/.claude/projects/<encoded-temp-cwd>/<sessionId>.jsonl`.
2. **Build a rebuilt rollout.** Mint a new session uuid. Construct a NEW rollout file in the
   same projects dir modeled on the real one but modified so recall proves the rebuilt file
   was loaded (e.g. keep the conversation but change the planted fact to
   "BRONZE-HERON-77" in the assistant's acknowledgment, or append a synthetic
   user+assistant exchange stating a second fact that never occurred in the real session).
   Follow the cc-lhc line shapes. Do NOT add a sessions-index entry yet.
3. **Swap.** Start a new adapter session with `resumeCursor: { resume: <newSessionId> }`.
   Send: "What is the deployment codename?" **Success =** the answer reflects the rebuilt
   file's content (BRONZE-HERON-77), not the original session's. Also confirm: the new
   turn appended to the REBUILT rollout file (check file growth), and note the session id
   the adapter now reports.
4. **Sessions-index question.** Did step 3 work without touching `sessions-index.json`?
   Answer explicitly (this decides whether the later rebuilder port needs the index code).
5. **Failure mode.** Start a session with `resumeCursor: { resume: <uuid that has no file> }`.
   Document exactly what happens: hard error? silent fresh session? Which — this determines
   whether swap failure is detectable at the integration point.
6. If any step fails, iterate on the rebuilt file's shape (that's the point of the probe) —
   document what was required (mandatory fields, parent chains, etc.).

## Deliverable

`docs/lhc/findings/claude-swap.md`:

- The verified recipe, step-by-step, with the exact resume-cursor shape and the minimal
  rebuilt-rollout requirements discovered (cite your probe files/line numbers).
- The sessions-index answer, the failure-mode answer, and file-append behavior post-swap.
- Scope note: this proves the mechanism at ADAPTER level. Name the server-level integration
  points for the real implementation (resume cursor persisted in
  `apps/server/src/persistence/ProviderSessionRuntime.ts`; live sessions must be stopped
  before the flip; `ProviderSessionReaper` exists at server level — flag interactions to
  check in Slice 2.2, don't chase them now).
- Probe script(s) in `packages/lhc-host/probes/` (outside the build, like the existing one).

## Report back

Recipe verdict up front (works / works-with-conditions / blocked), then evidence summary,
commands, deviations.
