# Task: Codex live acceptance run (Slice 4.3 — Phase 4 gate)

Mirror of the Phase 2 acceptance (`docs/lhc/briefs/slice-2.4.md` pattern,
`docs/lhc/findings/phase2-acceptance.md` result): first real execution of the codex swap
path against a live server. Deliverable: `docs/lhc/findings/phase4-acceptance.md` with a
PASS/FAIL table. No `git commit`. Paid calls authorized; cheapest usable codex model;
budget ~8-10 sessions total.

## Reuse

Boot + auth recipe: `docs/lhc/operations.md` (verifier-audited) and
`live-capture-validation.md`. Scratch: `T3CODE_LHC_HOME=$HOME/code/t3code-lhc/validation/lhc-home-p4`.
Driver probes in `packages/lhc-host/probes/`. Swap ground truth:
`docs/lhc/findings/codex-swap.md`. Temp git-repo cwds. No turns mid-swap.

## Checklist

1. **Grow**: codex thread, codename + fact in turn 1, 3-5 turns with large tool outputs.
   Cite reported token usage reached.
2. **Status/inspect**: thread listed with correct providerKind; tailTokens/
   compactRecommended present.
3. **Compact**: `POST /lhc/threads/:id/compact` → 200 receipt; rebuilt file under the
   dated `sessions/YYYY/MM/DD/` path; persisted cursor is bare `{threadId: <newId>}`;
   filename==session_meta id.
4. **Resume onto compacted context**: recall turn answers codename+fact; evidence the
   session resumed the rebuilt id; usage delta cited.
5. **Continuity**: 2 more turns → same LHC thread, no new lineage row, synthetic file
   grows.
6. **Second swap, quiesced thread (4.2 risk item)**: WITHOUT sending any turn after step
   5's last turn completes and the session goes idle/stopped (stop it explicitly via the
   API), fire a second compact. This exercises cwd resolution with no active session
   after the first swap's runtimePayload overwrite. PASS = 200 + next turn works;
   if it fails with a paths error, capture the binding's runtimePayload state — that
   confirms the known cwd-drop issue and its severity.
7. **Prune**: on the same thread or a fresh grown one → 200, next turn works.
8. **Error surfaces**: 404 unknown id; 409 busy during an in-flight turn; and one
   mixed-provider check — POST compact on a CLAUDE thread (start a small one) →
   routes to the Claude flow and succeeds (this is the dispatch's first real exercise
   AND the live regression proof that the 4.2 refactor didn't break Claude — one cheap
   compact is enough).
9. **Sanity sweep**: LHC logs, capture stats, server logs; note anything non-clean.
10. **authOverlay note**: report whether this box's codex instance uses authOverlay mode
    (read the config/driver state); if not exercisable here, mark N/A with one line of
    evidence — do not fake it.

## Failure protocol

Same as 2.4: evidence, FAIL, continue unless blocked. For a silent-swap analogue watch
`no rollout found for thread id` (missing/mispathed file) and fresh-session behavior
(no recall) — capture rebuilt-file head + cursor state before touching anything. Kill
all servers when done.

## Report back

PASS/FAIL table, per-item evidence, before/after usage, cost, deviations, punch-list for
Phase 5.
