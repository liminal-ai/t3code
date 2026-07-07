# Revision request: Slice 2.3 module hygiene (verifier finding)

Verification passed everything substantive (mechanism, flag semantics, test honesty,
blast radius). One hygiene fix:

The adapter imports `@t3tools/lhc-host/config`, but `config.ts` top-level imports the
inference setup (claude-cli, assignments), so the adapter's module graph now pulls the
entire inference lane just to read an env flag.

Fix: move the pure env-flag helpers (`isAutoCompactSuppressionEnabled` and any other
side-effect-free flag readers it belongs with) into a lean module —
`packages/lhc-host/src/flags.ts` — with NO imports beyond node builtins. Repoint the
package.json subpath export (rename it `./flags`, or keep `./config` but pointing at the
lean module — your call, keep it consistent) and update the adapter import + tests.
`config.ts` re-exports from `flags.ts` so capture-side callers don't churn.

The package.json export line itself is accepted (it was necessary); just make what it
exposes lean.

Constraints: `vp run typecheck` + `vp check` green; ClaudeAdapter tests + lhc-host tests
green. No commits. Report the diff.
