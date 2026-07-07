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
