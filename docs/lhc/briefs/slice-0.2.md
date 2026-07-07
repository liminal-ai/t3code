# Task: provider event-stream fidelity probe (Slice 0.2)

You are in a t3code fork. t3code's server wraps provider CLIs (Claude Code via the Claude
Agent SDK; Codex via `codex app-server`) behind adapters that emit a normalized event
stream (`ProviderRuntimeEvent`, `packages/contracts/src/providerRuntime.ts`). We plan to
capture conversations by consuming that stream (`item.completed`-based). **The open
question this probe answers: does the normalized stream carry FULL content, or is it lossy
— and where?** Your deliverable is an evidence-cited findings doc plus captured fixtures.
This is an investigation: you write scratch harness code and a report, you do NOT modify
`apps/server` or `packages/contracts` (read-only), and you do NOT `git commit`.

## Questions to answer, per provider (Claude AND Codex)

1. `item.completed` with `itemType: "user_message"` / `"assistant_message"` /
   `"reasoning"` — does the payload (`title`/`detail`/`data`) carry the FULL final text,
   or only truncated/partial forms with full text existing only across `content.delta`
   events? (v1 ingestion buffers deltas with a 24k-char cap — we must know whether
   completed items are self-sufficient.)
2. Tool lifecycle items (`command_execution`, `file_change`, `mcp_tool_call`, …) — do
   completed items carry full call arguments AND full tool output (e.g. Codex
   `aggregated_output`; Claude tool_result content)? At what size does anything truncate?
3. What does the optional `raw` field on events actually contain in practice, and would
   it recover anything the payload lacks?
4. Correlation: can a tool result be paired to its tool call from the stream alone
   (itemId stability across started/completed)?
5. Turn boundaries: confirm `turn.started`/`turn.completed`/`turn.aborted` fire reliably
   around the above (including one interrupted turn if easy to produce).

## Method (preferred order; use your judgment)

A. **Direct adapter harness** (most controlled): a scratch script under
`packages/lhc-host/probes/` (new dir, fine to create) that constructs the real adapter
and drives one session. Read `apps/server/src/provider/Layers/ClaudeAdapter.ts`
(`makeClaudeAdapter`), `CodexAdapter.ts` (`makeCodexAdapter`), their `.test.ts` files,
and `apps/server/src/provider/Drivers/*.ts` for construction requirements (Effect
services: ChildProcessSpawner, FileSystem, Path, etc. — see how tests/drivers provide
them). Subscribe `adapter.streamEvents`, write every event as JSONL, `startSession` +
`sendTurn`, let it finish, `stopSession`.
B. **Dev server + NDJSON logger** (fallback): `apps/server/src/provider/Layers/
   EventNdjsonLogger.ts` / `ProviderEventLoggers.ts` show how native event logging is
enabled (check server settings). Drive a session through the running dev server if the
adapter harness proves too fiddly.

Session content (keep cheap — real paid CLIs, both authed on this machine):

- Run each session in a FRESH TEMP git repo as cwd (never a real project; `git init` a
  scratch dir; codex requires a git repo).
- One turn that produces a LARGE tool output: e.g. prompt "run `seq 1 20000` and tell me
  the last number" (≈100KB+ output) — this is the truncation detector.
- One turn with a small file edit (file_change shape) and a normal text answer.
- Claude: a prompt that produces visible reasoning if effort settings allow.
- Use cheap/fast models where selectable (Claude: pass a small model via adapter model
  selection if straightforward; Codex: config default is fine).

Then diff against ground truth:

- Claude rollout: `~/.claude/projects/<encoded-temp-cwd>/<sessionId>.jsonl`
- Codex rollout: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (newest matching the run)
  Compare content sizes field-by-field for the large-output turn: rollout tool result bytes
  vs normalized-event payload bytes vs delta-stream total bytes.

## Deliverables

1. `docs/lhc/findings/event-fidelity.md` — per provider: a table of item/event type →
   where full content lives (payload field / deltas / raw / rollout-only), truncation
   points with observed byte counts, correlation and turn-boundary answers, and a final
   **tap-point recommendation** for the capture mapper: consume `item.completed` as-is /
   join deltas / read `raw` / patch the adapter payload in-fork (name the exact field and
   file if so). Every claim cites a fixture file + line.
2. Trimmed fixture pairs in `packages/lhc-host/test/fixtures/event-fidelity/{claude,codex}/`:
   the captured normalized-event JSONL and the matching rollout excerpt for the same turn
   (sanitize nothing that isn't secret; these are scratch sessions). Keep each under
   ~200KB — trim repetitive middles with a `[...trimmed N lines...]` marker line.
3. Probe scripts left in `packages/lhc-host/probes/` (they don't need to pass repo checks
   if excluded from tsconfig/test globs — keep them out of the build; note how you did).

## Constraints

- Read-only outside `packages/lhc-host/` and `docs/lhc/findings/`.
- No `git commit`. No pushes. No changes to `~/.claude` / `~/.codex` config.
- Budget: aim for ≤3 provider sessions per provider. If the adapter harness fights you for
  more than ~20 minutes of effort, switch to method B rather than burning time.

## Report back

Findings summary (the tap-point recommendation up front), commands run, session costs if
visible, deviations and why.
