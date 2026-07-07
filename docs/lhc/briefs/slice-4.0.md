# Task: Codex synthetic-rollout resume probe (Slice 4.0 — last structural unknown)

You are in a t3code fork. Prior research proved `codex exec resume` accepts synthetic
rollout files. t3code drives codex through **app-server** (`codex app-server`, JSON-RPC)
instead — and whether app-server's `thread/resume` accepts a synthetic rollout is the one
unproven assumption in this project. Your job: prove it or disprove it, and produce the
verified swap recipe (or the failure evidence + fallback assessment). Deliverable:
`docs/lhc/findings/codex-swap.md`. No `git commit`. Do NOT modify `apps/server` or
`packages/contracts`. Paid codex calls authorized — keep turns tiny (one-line prompts,
recall questions); budget ~6 sessions.

## Read first

1. `docs/lhc/findings/claude-swap.md` — the Claude analogue of what you're producing;
   mirror its rigor and structure (recipe, mandatory invariants, failure modes, traps).
2. `/Users/leemoore/code/pi-long-horizon/liminal-context/packages/codex-lhc/` (READ-ONLY)
   — the codex-lhc project's rollout format research and any rebuilder work. Explore it;
   whatever format report / experiments exist there are your head start on crafting
   synthetic files. Cite what you reuse.
3. `apps/server/src/provider/` codex pieces (read-only): how the adapter/session runtime
   starts app-server, what `CODEX_HOME` it uses, how `thread/resume` is invoked
   (CodexSessionRuntime), and where the codex resume cursor / thread binding is persisted
   (the analogue of Claude's `{threadId, resume, turnCount}` — document the exact codex
   shape; Slice 4.2 will flip it).
4. `packages/lhc-host/probes/event-fidelity-probe.ts` — the pattern for driving the real
   codex adapter in-process with a temp `CODEX_HOME`.

## The experiment ladder (stop early only on hard-blocked)

Temp `CODEX_HOME`, temp git-repo cwd, cheapest usable codex model.

1. **Baseline**: real session via the adapter, seed a codename ("BRONZE-HERON-77"-style)
   - one distinctive fact, 2-3 tiny turns. Locate the rollout under
     `CODEX_HOME/sessions/`. Record: path convention, session/thread id relationship,
     envelope shape, what the persisted t3 resume binding contains.
2. **Sanity resume**: stop the session, `thread/resume` the SAME id via the adapter, one
   recall turn — proves the resume path works before you introduce synthetic files.
3. **Synthetic same-process**: craft a synthetic rollout with a NEW session id
   (fabricated compacted history — codename embedded in a fabricated user/assistant
   exchange; envelope copied per codex-lhc's findings), place it, `thread/resume` the new
   id in the SAME app-server process. Recall turn. Does it load? Does it answer from
   fabricated history? Do new turns append to the synthetic file?
4. **Synthetic fresh-process**: same but restart the app-server process first (t3code
   owns the subprocess, so a restart is an available fallback in production). This
   distinguishes in-memory-index rejection from disk-loading rejection — the key
   diagnostic if 3 fails.
5. **Failure modes** (only if 3 or 4 passed): resume an id with no file (expected error?),
   malformed file (skipped lines vs hard reject?), id-vs-filename mismatch.
6. **Bonus if cheap**: `thread/fork` on a synthetic rollout — is fork-from-synthetic an
   alternative entry point?

## Findings doc must answer

- VERDICT up front: does app-server `thread/resume` accept synthetic rollouts —
  same-process? fresh-process only? not at all?
- The exact recipe for 4.2 (file placement, id rules, envelope requirements, cursor/
  binding flip shape, whether an app-server restart is required as part of the swap).
- Every trap found (the codex analogues of Claude's non-uuid-cursor and upsert-preserve
  gotchas).
- If REJECTED at both 3 and 4: the failure evidence (exact errors/logs) and your
  assessment of the fallback ladder (restart-based swap viability, `thread/fork`, what a
  minimal codex patch would need to touch — cite the relevant codex-rs source if you can
  see it in `.repos/` or codex-lhc's vendored copy).

## Report back

Verdict, evidence summary per ladder step, sessions/cost used, the 4.2 recipe or fallback
assessment, deviations.
