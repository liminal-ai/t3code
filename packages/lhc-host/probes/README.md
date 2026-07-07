# LHC Probes

Scratch tooling for `docs/lhc/findings/event-fidelity.md` (slice 0.2) and
`docs/lhc/findings/claude-swap.md` (slice 0.3).

These files are intentionally outside `packages/lhc-host/src`; the package
`tsconfig.json` includes only `src`, so the probes are not part of normal
typecheck/test globs.

Run from the repo root:

```sh
node packages/lhc-host/probes/event-fidelity-probe.ts --provider claude --include-interrupt
node packages/lhc-host/probes/event-fidelity-probe.ts --provider codex --include-interrupt
node packages/lhc-host/probes/trim-event-fidelity-fixtures.ts --provider claude --normalized packages/lhc-host/test/fixtures/event-fidelity/claude/claude-normalized.full.jsonl --rollout <claude-rollout-jsonl>
node packages/lhc-host/probes/trim-event-fidelity-fixtures.ts --provider codex --normalized packages/lhc-host/test/fixtures/event-fidelity/codex/codex-normalized.full.jsonl --rollout <codex-rollout-jsonl>

# Claude session-swap recipe (phases share state via test/fixtures/claude-swap/state.json)
node packages/lhc-host/probes/claude-swap-probe.ts --phase baseline
node packages/lhc-host/probes/claude-swap-probe.ts --phase rebuild    # no provider session
node packages/lhc-host/probes/claude-swap-probe.ts --phase swap
node packages/lhc-host/probes/claude-swap-probe.ts --phase missing
```
