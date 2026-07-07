# Task: scaffold `packages/lhc-host` package (Slice 0.1)

You are working in a fork of t3code (a pnpm monorepo). Create a new workspace package that
hosts the LHC SDK (an external long-horizon-context SDK) and prove it links and runs with a
smoke test. This is scaffold-only — no server wiring, no changes outside the new package
except the pnpm lockfile.

## What to build

1. `packages/lhc-host/` — new package, name `@t3tools/lhc-host`, private, `"type": "module"`.
   Mirror the conventions of `packages/shared` (read its `package.json` and `tsconfig.json`
   first): same script shapes (`typecheck`, `test` via the repo's `vp` tooling), same tsconfig
   extends pattern, explicit subpath exports (no barrel index needed yet — a single
   `./smoke`-style export or just `main` is fine at this stage).

2. Dependency on the LHC SDK, which lives OUTSIDE this repo at
   `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/lhc` (package name `lhc`,
   prebuilt `dist/` present — do NOT modify anything in that repo, treat it as read-only).
   Use a pnpm `link:` dependency with the correct relative path from `packages/lhc-host`
   (this repo is at `~/code/t3code-lhc/t3code`, so the target is
   `link:../../../../pi-long-horizon/liminal-context/packages/lhc` — verify by resolving it).
   Run `pnpm install` at the repo root to register the package; lockfile changes are expected
   and fine. If pnpm engine checks complain about the lhc package's engines field, do not
   edit that package — report the failure in your final message instead of working around it.

3. A smoke test `packages/lhc-host/src/sdk-smoke.test.ts` proving the SDK works in-process:
   - Read these files from the SDK repo first to learn the real API (read-only):
     - `.../packages/lhc/src/sdk.ts` — `initLhc(config)`, the `Lhc` surface, and the exported
       `createDeterministicInferenceCallbacks`
     - `.../packages/lhc/src/threads/index.ts` — `newThread` signature and registry/thread-file
       path handling
     - `.../packages/cc-lhc/src/intake/session.ts` — a working host example: how it constructs
       `initLhc` config and calls `intakeStream.messageEvents`
   - The test should: create a temp directory; construct an SDK instance in `"manual"` mode
     with deterministic inference callbacks (no model calls, no network); create a new thread
     (thread file + registry both under the temp dir — never write to `~/.lhc` or any home
     directory path); intake a small batch of events (a `user_prompt`, an `assistant_text`,
     and a `turn_end`) via `intakeStream.messageEvents` with idempotency keys; read them back
     via `messages.list` and assert count and kinds; send the same batch again and assert the
     duplicates are skipped (idempotency). Clean up the temp dir.
   - LHC operations return `OpResult` (`{ok:true,value}` | `{ok:false,error}`) — assert on
     `ok` explicitly; do not assume throws.

## Acceptance (all must pass, run them yourself)

- `vp run typecheck` passes at the repo root.
- `vp check` passes at the repo root.
- `vp run --filter @t3tools/lhc-host test` (or the repo-conventional equivalent) runs the
  smoke test green.
- `git status` shows changes only under `packages/lhc-host/` plus `pnpm-lock.yaml` (and
  `pnpm-workspace.yaml` ONLY if the workspace glob doesn't already cover `packages/*`).
- Nothing written outside the repo and the temp dirs; the liminal-context repo untouched.

## Report back

End with: what you created, the exact commands you ran with their results, any deviation from
this brief and why, and anything about the SDK link that felt fragile (for the impl log).
