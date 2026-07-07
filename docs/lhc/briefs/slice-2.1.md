# Task: port the cc-lhc Claude rollout rebuilder (Slice 2.1)

You are in a worktree of a t3code fork. Port the proven Claude rollout rebuilder from the
external cc-lhc package into `packages/lhc-host/src/claude-swap/`. Like the earlier
inference-lane port (see `docs/lhc/briefs/slice-1.2a.md` for the pattern and its verified
outcome), this is a near-verbatim port — do NOT redesign. The rebuilder turns an LHC
`SessionThreadView` into a fresh Claude Code rollout JSONL file that the Agent SDK can
resume (mechanism proven in `docs/lhc/findings/claude-swap.md` — read it first).

## Source (read-only — never modify that repo)

In `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/cc-lhc/`:

- `src/rollout/rebuild.ts` (SessionThreadView → rollout lines; envelope reconstruction)
- `src/rollout/write-rebuilt.ts` (fsync'd write to a new session-id path)
- `src/rollout/types.ts` (line shapes) — port what the two modules need
- their tests under `test/rollout/` + any fixtures they use
- Do NOT port `sessions-index.ts`: the 0.3 probe proved the index is not required for
  Agent SDK resume (findings doc, "sessions-index" answer). If `write-rebuilt.ts` calls
  it, strip that call and note it.

## Target and adaptations (ONLY these)

`packages/lhc-host/src/claude-swap/rebuild.ts`, `write-rebuilt.ts`, `types.ts`, tests
under `src/claude-swap/*.test.ts`, fixtures under `test/fixtures/claude-swap-rebuild/`.

1. Import paths (`lhc` is a direct dep; see how `src/intake/mapper.test.ts` imports).
2. Path derivation: cc-lhc computes the projects dir from the real `$HOME`; here the
   Claude home is per-provider-instance (t3code can override HOME per instance — see
   `apps/server/src/provider/Drivers/ClaudeHome.ts`, read-only). Parameterize: the write
   function takes an explicit `claudeProjectsDir` (or `claudeHomePath` + cwd and derives
   `<home>/.claude/projects/<encoded-cwd>/`). Port cc-lhc's cwd-encoding logic exactly,
   and preserve the macOS realpath gotcha noted in `docs/lhc/findings/claude-swap.md`
   (temp cwds encode via `/private/var/...` realpath) — encode from the realpath.
3. Env/prefix renames as in 1.2a (`[cc-lhc]` → `[t3code-lhc]` if any).
4. The toolchain adaptations the 1.2a port needed (namespace node imports,
   effect-diagnostics pragmas, erasableSyntaxOnly, vite-plus/test) — apply the same way.
5. Keep the `RebuildRolloutInput` interface shape so a future codex rebuilder can mirror
   it (that interface seam is a standing decision in the plan).

Everything else byte-diffable: line shapes, parent-uuid chain construction, envelope
scalar handling, the trailing runtime-note behavior, fsync semantics.

## Acceptance

- Ported tests green via `pnpm exec vp run --filter @t3tools/lhc-host test`.
- `pnpm exec vp run typecheck` + `pnpm exec vp check` green at root.
- Diff vs originals shows only the allowed adaptation categories — include the summary.
- One NEW test (not from cc-lhc): rebuild a rollout from a real `SessionThreadView`
  produced by an actual LHC SDK instance in a temp dir (reuse the smoke-test construction
  pattern: create thread, intake a few turns, `getSessionThreadView`), write it via the
  port, and assert the output parses line-by-line as valid rollout JSONL with the
  session-id/filename/parent-chain invariants from the findings doc. No provider calls.
- No changes outside `packages/lhc-host/`. No `git commit`.

## Report back

Files ported, diff summary, the sessions-index strip note, test results, deviations.
