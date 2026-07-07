# Task: port the codex-lhc rollout rebuilder (Slice 4.1)

You are in a worktree of a t3code fork. Port the Codex rollout rebuilder from the
external codex-lhc package into `packages/lhc-host/src/codex-swap/`, near-verbatim — do
NOT redesign. This is the third port of this kind; follow the proven pattern from
`docs/lhc/briefs/slice-2.1.md` (Claude rebuilder port) and its outcome.

## Sources (read-only — never modify that repo)

In `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/codex-lhc/`:

- `src/rollout/` — the rebuilder modules (rebuild + writer + types; explore the dir)
- `test/rollout/rebuild.test.ts` + `test/fixtures/codex-rollout-samples.jsonl`
- `docs/codex-rollout-format-report.md` — format ground truth

## Ground truth for the resume contract

`docs/lhc/findings/codex-swap.md` (in this repo) — read fully. Its invariants OVERRIDE
anything the codex-lhc source does differently, notably:

- **The writer MUST enforce filename id == session_meta id** (the probe proved a mismatch
  is accepted by app-server but returns the session_meta id — which would silently poison
  t3code's persisted cursor). If the codex-lhc writer doesn't guard this, ADD the guard
  (assert + throw) and note it as a deliberate deviation.
- First line must be valid `session_meta`; write clean JSONL throughout (later-line
  leniency exists but must not be relied on).
- Path convention `CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl` —
  parameterize the sessions root (per-instance CODEX_HOME) the same way the Claude port
  parameterized `claudeProjectsDir`.

## Adaptations (ONLY these — same categories as slice 2.1)

Import paths for the linked `lhc` dep; namespace node imports + effect-diagnostics
pragmas + vite-plus/test toolchain fixes; sessions-root parameterization; env/prefix
renames; the id-match guard above. Keep interface parity with the existing
`RebuildRolloutInput` seam in `src/claude-swap/` (standing decision — the two rebuilders
should look alike to their consumer; if the codex-lhc input shape differs, adapt the
SURFACE to match the seam and keep internals verbatim).

## Acceptance

- Ported tests green: `pnpm exec vp run --filter @t3tools/lhc-host test`; root
  `vp run typecheck` + `vp check` green.
- One NEW integration test (same pattern as 2.1's): real LHC SDK in temp dir → intake a
  few turns → `getSessionThreadView` → write via the port → assert line-by-line valid
  rollout JSONL + the codex-swap.md invariants (session_meta first, filename==meta id,
  fabricated exchange shape). No provider calls.
- Diff summary vs originals showing only allowed categories.
- No changes outside `packages/lhc-host/`. No `git commit`.

## Report back

Files ported, diff summary, whether the id-guard existed or was added, seam adaptation
notes, test results, deviations.
