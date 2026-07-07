# Revision request: Slice 4.2 backfill (verifier findings — all small)

Verdict was ACCEPT; these are the non-blocking findings, worth closing before the live
run. All in `packages/lhc-host/` except item 4.

1. **Restore the dropped invariant comments.** The Window A/B concurrency-model comment
   (at the lock) and the flip-last invariant comment were lost in the core extraction —
   restore them in `swap/core.ts` at the corresponding sites (they document constraints
   the code can't show; copy from `git show HEAD~1:packages/lhc-host/src/swap/claude.ts`
   if needed... note HEAD may already contain the refactor — use the impl-log 2.2 entry
   text as the source if the old file is gone from history reachable to you).
2. **Codex mirror test backfill**: add the idle-retry-success test and the cross-thread
   concurrency test (mirror Claude's #5 and #7) to `swap/codex.test.ts`.
3. **`expectedReintakeLines` fix**: codex maps it `:= replayedPrefixLines` making the
   integration assertion tautological, and its meaning diverges from Claude's (total
   lineCount incl. receipt). Unify: make BOTH writers report the same semantics — total
   line count of the written file (Claude's current meaning) — and fix the codex
   integration assertion to check it against an independently computed count (read the
   file, count lines), not against the same field.
4. **Route-level dispatch test** (server): a cheap test covering
   `providerKindForThread` dispatch — claude row → claude controller, codex row → codex
   controller, other → `unsupported_provider`. If the server test harness makes this
   expensive, a focused unit test of the dispatch function is enough.

Gates: full lhc-host suite + server.test.ts + typecheck + check green. Claude swap tests
still unmodified. No commits.
