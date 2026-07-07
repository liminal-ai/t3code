# Task: port the cc-lhc inference lane (Slice 1.2a)

You are in a worktree of a t3code fork. Port the proven `claude -p` subprocess inference
provider from the external cc-lhc package into `packages/lhc-host`, as close to verbatim
as possible — this module is deliberately host-independent and already tuned; do NOT
redesign it.

## Source (read-only — never modify that repo)

`/Users/leemoore/code/pi-long-horizon/liminal-context/packages/cc-lhc/src/inference/claude-cli.ts`
`/Users/leemoore/code/pi-long-horizon/liminal-context/packages/cc-lhc/src/inference/assignments.ts`
and their tests under `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/cc-lhc/test/inference/`.

## Target

`packages/lhc-host/src/inference/claude-cli.ts`, `assignments.ts`, and tests under
`packages/lhc-host/src/inference/*.test.ts` (or the package's existing test layout —
mirror how `sdk-smoke.test.ts` is placed and discovered).

## Allowed adaptations (ONLY these)

1. Import paths (the `lhc` package is a direct dependency here — check how
   `src/sdk-smoke.test.ts` imports it).
2. Env prefix: `CC_LHC_*` → `T3CODE_LHC_*` (e.g. `T3CODE_LHC_INFERENCE_CONCURRENCY`,
   `T3CODE_LHC_CLAUDE_BIN`, `T3CODE_LHC_NO_INFERENCE`).
3. Any output/log prefix `[cc-lhc]` → `[t3code-lhc]`.
4. Default concurrency cap: cc-lhc uses 3; set the default to **8** here (ruling from
   `docs/lhc/findings/concurrency.md` — cite it in a one-line comment stating the
   constraint, not the history).
5. Whatever trivial type-source changes the linked `lhc` package version requires.

Keep everything else byte-diffable against the originals: same function names, same
failure classification, same `liveChildren` tracking and `killAllInferenceChildren`
teardown, same model assignments (Sonnet-no-thinking baseline, ratio steering on the two
compression lanes). Port the tests the same way.

## Acceptance

- `pnpm exec vp run --filter @t3tools/lhc-host test` green (ported tests included).
- `pnpm exec vp run typecheck` and `pnpm exec vp check` pass at repo root.
- `diff` of each ported file against its cc-lhc original shows only the five allowed
  adaptation categories — include the diff summary in your report.
- No changes outside `packages/lhc-host/`. No `git commit`.
- Do NOT run real `claude -p` calls; the ported tests should be hermetic like the
  originals (check how cc-lhc's tests fake the binary — `fake-claude.mjs` style fixtures
  are fine to port too).

## Report back

Files ported, the allowed-adaptation diff summary, commands run, any place the port
couldn't stay verbatim and why.
