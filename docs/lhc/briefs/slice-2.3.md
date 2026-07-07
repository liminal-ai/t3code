# Task: Claude native auto-compact suppression (Slice 2.3)

You are in a t3code fork where LHC is taking over context management for Claude threads.
Claude Code's native auto-compact must be suppressible per-session so it can't fight
LHC's compaction. Investigate the mechanism, implement it flag-gated in the fork's Claude
session-start path, and prove the plumbing with tests. Small, contained slice.

## Investigate first (document what you find in your report)

1. How the Agent SDK / Claude Code decides auto-compact:
   `apps/server/src/provider/Layers/ClaudeAdapter.ts` reads
   `isAutoCompactEnabled` from a capabilities/config response (~line 485,
   `compactsAutomatically`). Trace where that value comes from: an SDK `query()` option?
   A settings file under the session HOME (`~/.claude/settings.json` has
   `autoCompactEnabled`)? An env var? Check `node_modules/@anthropic-ai/claude-agent-sdk`
   types (the `Options` type) for anything auto-compact-related, and how
   `makeClaudeEnvironment` (`Drivers/ClaudeHome.ts`) shapes the session HOME.
2. Pick the least invasive per-session mechanism, in preference order: an SDK query
   option if one exists; else an env var on the session's process env if one exists;
   else settings injection (careful: the session HOME may be the user's real HOME —
   mutating the user's `~/.claude/settings.json` is FORBIDDEN; if settings-file injection
   is the only path, report that as the finding and implement only the option/env path
   as far as it goes, marking the gap).

## Implement

- Flag: `T3CODE_LHC_SUPPRESS_AUTOCOMPACT` — default ON when LHC capture is enabled,
  forced OFF when `T3CODE_LHC_DISABLE=1`. Read it wherever the fork already reads
  T3CODE*LHC*\* env (`packages/lhc-host/src/config.ts`) and export a small helper the
  adapter can consume without importing capture internals.
- Apply it in the Claude session-start path (`ClaudeAdapter.ts`) — keep the diff tiny and
  clearly marked, same style as the existing slice-1.0/1.2 fork patches.
- Unit test: whatever mechanism you land on, assert it's applied when the flag is on and
  absent when off (adapter test file has patterns for asserting constructed query
  options/env).

## Acceptance

- ClaudeAdapter test file green; `vp run typecheck` + `vp check` green at root.
- Diff: ClaudeAdapter.ts (+ its test), `packages/lhc-host/src/config.ts` (+ test) only.
- The LIVE proof (a thread pushed past the native threshold shows no compact_boundary)
  is explicitly deferred to Slice 2.4's acceptance run — state in your report what 2.4
  should check.
- No `git commit`.

## Report back

The mechanism found (with evidence), what you implemented, the 2.4 live-check
instruction, test results, deviations.
