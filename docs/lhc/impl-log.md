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
