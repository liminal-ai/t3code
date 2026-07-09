# Task: fix sync-smoke's live-run defects (Slice A2 debug round)

You are in a t3code fork worktree. `packages/lhc-host/smoke/sync-smoke.ts` (+ lib.ts,
capture.ts, http.ts, runtime.ts) was just written and its first full live run produced
4 FAILs. The orchestrator's read: these are SCRIPT bugs, not product regressions — your
job is to verify that read (challenge it if the evidence disagrees), fix the script, and
produce a fully green live run. The report: `docs/lhc/sync-reports/2026-07-09-1906.md`.

Product ground truth: `docs/lhc/operations.md`, `docs/lhc/findings/phase2-acceptance.md`
and `phase4-acceptance.md` (these flows WORKED live two days ago via the probes the
script was distilled from — `packages/lhc-host/probes/phase2-acceptance.ts`,
`phase4-acceptance.ts`, `ws-driver.ts`).

## The four failures + orchestrator's hypotheses (verify each)

1. **"open turns remain: 1" (both providers)** — WRONG ASSERTION. One open turn is the
   canonical healthy state of an LHC record (the latest turn stays open; see
   phase2-acceptance evidence: `{open:1, closed:N}` was the PASS shape everywhere).
   Fix: assert open ≤ 1 (or exactly the expected shape), not 0.
2. **claude tool_result bytes 0, and "claude turns PASS in 3.0s"** — the script is very
   likely not awaiting actual turn completion (3s cannot cover seed + ok + seq-tool
   turns on any model). Compare your turn-completion wait against how
   `phase2-acceptance.ts`/`ws-driver.ts` monitor turn state (they poll/subscribe until
   the turn reaches a terminal state). Fix the await, and the tool_result check should
   then see real bytes.
3. **resume recall answer "" (both providers)** — empty string on BOTH providers smells
   like broken answer extraction (the probes' `assistantAnswer` worked; check what your
   port of it actually reads), possibly compounded by #2 (asking before the turn
   completed). A genuine recall failure would produce a wrong answer, not an empty one.
4. **Failure evidence = server boot banner** — `logTail()` evidence is the boot QR
   banner, useless. Turn-level failures should capture turn-scoped evidence (the
   turn's final state, last assistant message, relevant HTTP bodies), not the spawn log.

Also carried from the brief, re-verify these still hold after your fixes: report written
on EVERY exit path; real failure reasons on stderr; budget ≤8 paid turns per full run;
hang guard 120s/turn.

## Iteration protocol

- Free loop: `--skip-claude --skip-codex` covers setup/teardown paths.
- Paid loop: you MAY run the full script to verify (haiku + gpt-5.4-mini low — the
  script's own models). Budget: ≤3 full runs (≤24 paid turns total). If still red after
  3, stop and report findings honestly.
- A dogfood server runs on port 4601 — the script's ephemeral ports avoid it; do not
  touch that server yourself.
- If any failure turns out to be a REAL product regression from the upstream merge,
  STOP on that item and report it precisely (which check, which behavior, evidence) —
  do not paper over it in the script.

## Acceptance

Full live run: all 13 steps PASS, report written, exit 0. `vp run typecheck`,
`vp check`, lhc-host tests green. No `git commit`.

## Report back

Root cause per failure (script bug vs product bug), what you changed, the green run's
report path + paid-turn count, and any product observations worth recording.
