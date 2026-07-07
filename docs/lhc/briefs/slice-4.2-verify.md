# Verification task: audit Slice 4.2 codex swap + core refactor (verify, don't fix)

No file modifications, no commits, no paid calls. You may run package/server tests and
read-only shell.

Implementer's brief: `/Users/leemoore/code/t3code-lhc/briefs/slice-4.2.md`.
Ground truth: `docs/lhc/findings/codex-swap.md`; the 2.2 entries in `docs/lhc/impl-log.md`.
Under audit: uncommitted diff — `packages/lhc-host/src/swap/{core,claude,codex}.ts` +
tests, `src/http.ts` changes, `apps/server/src/server.ts`, new
`apps/server/src/provider/Drivers/CodexSwapHome.ts`.

## Check, in priority order

1. **Claude behavior preservation through the refactor (strictest item).**
   `git diff` on `swap/claude.test.ts`: assertions must be UNCHANGED (import paths
   aside). Then read the extracted `core.ts` against the pre-refactor claude.ts flow
   (git show HEAD:packages/lhc-host/src/swap/claude.ts): every 2.2 invariant must
   survive — flip-last, pre-flip active-session abort, post-flip re-read +
   retry-once-when-idle, per-thread lock scope, busy check, error classification with
   stepReached, receipt shape, runtime-note-after-success-only. Any semantic drift in
   the shared core is the highest-severity finding.
2. **Codex strategy vs the findings recipe.** Cursor flip writes bare
   `{ threadId: <newSessionId> }` — check against what CodexSessionRuntime actually
   reads on session start (does anything else in the binding need updating — turnCount
   analogue, runtime payload fields naming the old thread id?). Contested-flip re-read
   compares the right field. Source-rollout lookup handles the dated-dir layout
   (`sessions/YYYY/MM/DD/`) including sessions spanning days.
3. **CodexSwapHome.ts.** Continuation-key parse `codex:home:<path>` — mirror-check
   against how the codex driver actually builds it AND the default-home case (the 2.2
   Claude audit caught exactly this class of divergence — does codex have the same
   process.env vs homedir edge? What does the codex adapter use when no explicit home is
   configured?).
4. **Endpoint routing.** providerKind routing correct for both; `unsupported_provider`
   mapping + test; no path where a codex thread hits the Claude flow or vice versa
   (lineage row providerKind is the discriminator — can it be stale/wrong after a
   provider switch on the same t3 thread? What happens then?).
5. **Codex tests honesty.** Mirror-set genuinely equivalent to Claude's (spy-on-write
   cursor assertions, structural flip-last, contested both windows); integration test
   uses real compact + real writer + id-guard.
6. **Server diff containment.**

Run: full lhc-host suite; server.test.ts; ProviderService/ClaudeAdapter suites if
touched. Report which you could run.

## Report

Verdict per item (item 1 first), overall ACCEPT or REVISE-with-findings, file/line
specifics, open risks for 4.3.
