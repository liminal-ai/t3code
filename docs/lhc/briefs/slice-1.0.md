# Task: ClaudeAdapter fidelity patch + fixture regeneration (Slice 1.0)

You are in a t3code fork where we are deliberately patching the server (this is sanctioned
— it's our fork). The Phase-0 fidelity probe (`docs/lhc/findings/event-fidelity.md`, read
it fully first) found the Claude adapter's normalized event stream is lossy in two ways
that block our capture layer. Fix both in
`apps/server/src/provider/Layers/ClaudeAdapter.ts`, then regenerate the Claude fixtures to
prove it. Keep the diff contained to the Claude adapter (+ its test file if needed) — no
contract changes should be necessary (`ItemLifecyclePayload.data` is `Schema.Unknown`).

## Patch 1 — full tool output on completed tool items

Today, when Claude Code persists a large tool output to its sidecar
(`raw.payload.tool_use_result.persistedOutputPath` / `persistedOutputSize` on the
tool-result user message), the completed item's `payload.data.result.content` carries only
a ~2-3KB `<persisted-output>` preview. Evidence: fixtures
`packages/lhc-host/test/fixtures/event-fidelity/claude/claude-normalized.jsonl` lines
12-14 and `claude-tool-result-sidecar-excerpt.txt`.

In `handleUserMessage` where `toolData` is built: when persisted-output metadata is
present, read the sidecar file and surface the full output as a durable field —
`payload.data.result.fullOutput` (string) plus `fullOutputPath` and `fullOutputSize`
metadata. Requirements:

- Read failures must not break the event: fall back to the existing preview content and
  include `fullOutputPath`/`fullOutputSize` so downstream can note the gap. Never throw
  into the adapter's event pipeline.
- Hard size cap 10 MB: above it, skip `fullOutput` and set the path/size metadata only.
- Use the adapter's existing filesystem access idioms (it runs inside Effect but the SDK
  message handling may be plain async — match the surrounding code's style; a plain
  `node:fs/promises` read is acceptable if that's consistent with how the handler runs).

## Patch 2 — reasoning items

Claude rollouts contain `thinking` content blocks, but the normalized stream emitted no
`reasoning` item and no `reasoning_text` delta (see findings, "reasoning" row — the
`ClaudeTextStreamKind` type already includes `"reasoning_text"`, so plumbing partially
exists). Investigate why thinking blocks don't reach the stream and fix it so a thinking
block produces a normalized `reasoning` item (`item.started`/`item.completed` with the
thinking text in the payload, and `reasoning_text` deltas if the surrounding code already
streams text deltas). If this turns out to require deep surgery (e.g. the SDK message
shape genuinely lacks thinking in this mode), STOP on this patch, leave Patch 1 intact,
and document exactly what you found in your report — do not force it.

## Fixture regeneration

Re-run the existing probe for Claude only:
`node packages/lhc-host/probes/event-fidelity-probe.ts --provider claude`
(check its flags; budget ≤3 sessions — cheap model is fine, but for reasoning you need a
thinking-capable configuration: check how the probe selects model/effort and use a prompt
that elicits thinking, e.g. "think step by step about whether 91 is prime, then answer").
Regenerate/extend the fixtures under
`packages/lhc-host/test/fixtures/event-fidelity/claude/` (keep the trimming convention:
`[...trimmed N bytes...]` markers, files ≤200KB) so they now show:

- a completed tool item whose `payload.data.result.fullOutput` is the full 108,894-byte
  seq output (trimmed in the fixture, with the summary JSON recording true byte counts),
- a `reasoning` completed item (if Patch 2 succeeded).

Update `docs/lhc/findings/event-fidelity.md`: amend the Claude rows for
`command_execution large output` and `reasoning` to reflect post-patch reality, marked
clearly as "(post-patch, this fork)" so the pre-patch findings remain on record.

## Acceptance

- `pnpm exec vp run typecheck` and `pnpm exec vp check` pass at repo root.
- Existing ClaudeAdapter tests still pass (`pnpm exec vp run --filter t3 test` may be
  heavy — at minimum run the adapter's own test file; report what you ran).
- Regenerated fixtures + amended findings doc as above.
- Diff contained: `apps/server/src/provider/Layers/ClaudeAdapter.ts` (+ test file,
  - fixtures, + findings doc, + probe script only if a flag was needed). Nothing else.
- No `git commit`.

## Report back

What you changed and why, the reasoning-patch outcome (fixed / not-feasible-with-evidence),
fixture evidence lines, commands run, deviations.
