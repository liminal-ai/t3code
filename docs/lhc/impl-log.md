# t3code-lhc implementation log

Append-only. Every subagent launch, outcome, ruling, and next action gets an entry at
launch/completion time. Newest entries at the bottom. Format:

```
## YYYY-MM-DD — <slice or topic>
- status: launched | done | failed | ruling | note
- who: <model/tool or "Lee" or "orchestrator">
- what: <one paragraph>
- next: <the immediate next action>
```

---

## 2026-07-07 — workspace + plan

- status: done
- who: orchestrator (Claude Fable 5)
- what: Created `~/code/t3code-lhc/`, cloned `liminal-ai/t3code` fork (base pin
  `6e42231cb`, upstream remote added), branch `lhc`, wrote
  `docs/lhc/implementation-plan.md`. All standing decisions ratified with Lee in the
  planning session (see plan). Scope: Claude + Codex only; disposable-on-v1 strategy.
- next: Lee grants subagent CLI access; assign models to Phase 0 slices (0.2/0.3/0.4
  parallelizable); launch Slice 0.1.

## 2026-07-07 — delegation rules ratified

- status: ruling
- who: Lee
- what: Coders code, verifiers verify, orchestrator facilitates until convergence.
  Easy/moderate coding → Composer (alt: Fable 5 medium). Difficult coding → GPT-5.5 high.
  Verification defaults GPT-5.5 high; GPT-coded work is verified by Fable high
  (cross-perspective: Composer≈old-Claude distillation, so never Claude-verifies-Composer).
  GPT-5.5 excluded from easy coding (over-guards; tombstone tests). Machine defaults
  confirmed: codex → gpt-5.5/high, claude → fable/high. Slice assignment table added to plan.
- next: launch Slice 0.1 (Composer).

## 2026-07-07 — Slice 0.1: scaffold + SDK link

- status: done
- who: Composer 2.5 (cursor-subagent run 20260707-093159-d9c1a9); verified GPT-5.5 high
  (codex-subagent, read-only audit) — ACCEPT, one round
- what: `packages/lhc-host` scaffolded (`@t3tools/lhc-host`), lhc SDK linked via
  `link:../../../../pi-long-horizon/liminal-context/packages/lhc`, smoke test green
  (manual mode, temp-dir storage, intake + read-back + idempotency re-send). Gates:
  `vp run typecheck`, `vp check`, package test all pass. Deviation kept: `vp fmt` on the two
  docs/lhc files (vp check required it). Verifier concern (non-blocking): lockfile
  peer-resolution churn beyond the lhc entry. Fragility notes for later cleanup: relative
  link path couples repo locations; relies on prebuilt lhc dist; lhc uses effect@3 vs
  t3code's effect@4 catalog — keep lhc-host a thin boundary that imports only from `lhc`;
  engines overlap only at node 24.17.x.
- next: launch probes — 0.4 (concurrency harness, GPT-5.5, no dev server needed) can start
  immediately in a worktree; 0.2/0.3 need a running dev server + authed provider CLIs
  (machine choice: this Mac vs Linux box — Lee to confirm, defaulting to Mac).

## 2026-07-07 — Slices 0.2, 0.3, 0.4: all Phase 0 probes done and converged

- status: done
- who: 0.2 GPT-5.5 high (run -2ded25, 13.3m), verified Fable high (ACCEPT). 0.3 Fable high
  (run -2669b4, 7.7m), verified GPT-5.5 high (REVISE→doc revision→converged). 0.4 GPT-5.5
  high (run -e32ebb, 8.5m), verified Fable high (REVISE→4 fixes→converged, real smoke green
  46.6s on haiku).
- what:
  **0.2 (event fidelity)** — findings/event-fidelity.md. Codex: `item.completed` fully
  sufficient (108,894-byte aggregatedOutput verified byte-exact; normalized stream carries
  MORE than the rollout). Claude: LOSSY two ways — (a) user prompts emit NO completed
  user_message item; (b) large tool output truncates to ~3KB payload (`<persisted-output>`
  wrapper; full 108,894 bytes only in the Agent SDK sidecar file it names). Both providers:
  interrupts are `turn.completed` with state interrupted/failed — `turn.aborted` never
  fires. Correlation via itemId stable. Tap ruling: Codex = item.completed as-is; Claude =
  needs remedy (in-fork adapter payload patch preferred; sidecar/raw fallback).
  **0.3 (Claude swap)** — findings/claude-swap.md. Swap recipe VERIFIED first-try at
  adapter level: cc-lhc rebuild-core line shape + `resumeCursor:{resume:<newId>}` resumes
  the rebuilt file (BRONZE-HERON-77 recall), new turns append to it, sessions-index NOT
  required. Failure modes: ghost uuid detectable at first turn ("No conversation found");
  non-uuid cursor silently → fresh session (pre-validate!). Flip must actively write cursor
  (ProviderSessionDirectory upsert preserves omitted field) after stop/quiesce;
  resumeSessionAt cleared on flip. Races for 2.2 checklist: file-delete-between-check-and-
  turn; reaper revival.
  **0.4 (concurrency)** — findings/concurrency.md + harness in
  packages/lhc-host/test/concurrency/. No SDK correctness defects at 10–20 threads (clean
  drains, no contamination, no leftover work, retries don't wedge neighbors). SDK has NO
  global inference cap (concurrency == thread count, architecturally confirmed) — host must
  cap; recommendation 8. Real `claude -p` smoke green, flag-gated, env can't leak paid
  calls into simulated tests.
- next: Phase 1 — launch 1.1 (mapper, GPT-5.5 high). Mapper design must incorporate 0.2
  rulings: Claude user_prompt captured host-side from sendTurn input (not the stream);
  Claude tool-output remedy decided in 1.1 brief (adapter patch vs sidecar read).
