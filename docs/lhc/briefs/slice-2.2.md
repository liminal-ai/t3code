# Task: Claude swap orchestration + control endpoints (Slice 2.2 — Phase 2 core)

You are in a t3code fork with LHC capture live (Phase 1) and the Claude rollout rebuilder
ported (`packages/lhc-host/src/claude-swap/`). Build the orchestration that makes LHC
compaction actually take effect on a live Claude thread, plus minimal HTTP endpoints to
drive it. This is the highest-risk slice of Phase 2: the swap mutates provider state, so
failure-safety is the design center — a failed swap must leave the thread exactly as it
was.

## Mandatory reading, in order

1. `docs/lhc/findings/claude-swap.md` — the verified swap recipe. Every mechanism detail
   in it is ground truth: the exact persisted cursor shape from `updateResumeCursor`
   (`{threadId, resume: <newSessionId>, turnCount}`), the session-directory upsert gotcha
   (an omitted cursor is PRESERVED — the flip must actively write after quiesce), the
   non-uuid-cursor silent-fresh-session trap, filename==sessionId invariants.
2. `docs/lhc/implementation-plan.md` (slice 2.2 + standing decisions) and
   `docs/lhc/impl-log.md` (rulings).
3. `packages/lhc-host/src/claude-swap/` — `writeRebuiltRollout` (your step 5) and its
   `RebuildRolloutInput`.
4. In `/Users/leemoore/code/pi-long-horizon/liminal-context` (READ-ONLY):
   `packages/lhc/src/sdk.ts` for the compact/prune operation surface (how a compact is
   planned/applied on a thread, and how `getSessionThreadView` renders the post-compact
   view), and `packages/cc-lhc/src/` for the existing host's serving flow (how cc-lhc
   sequences compact → view → rebuild → swap) — mirror its sequencing logic, not its
   host mechanics (it does PTY injection; we do cursor flip).
5. `apps/server/src/provider/Layers/ClaudeAdapter.ts` — resume-cursor persistence
   (~line 1453 `updateResumeCursor` and wherever the session directory upsert lives),
   and how session stop works. `apps/server/src/provider/Services/ProviderService.ts` —
   stopSession + how to tell whether a thread has an active/in-flight turn.
   `apps/server/src/orchestration/http.ts` (or wherever the server registers HTTP
   routes) — for endpoint registration.

## The swap flow (Claude only in this slice)

`compactThread(t3ThreadId, opts)` / `pruneThread(t3ThreadId, opts)` in
`packages/lhc-host/src/swap/`:

1. **Resolve** lineage (t3 thread → LHC thread). No lineage row → clean "not captured"
   error.
2. **Busy check**: if the thread has an in-flight turn, reject with a retriable "busy"
   error (do NOT queue, do NOT interrupt — v1 semantics). Take a per-thread swap lock
   (concurrent swap requests on one thread: second gets "swap in progress"; different
   threads may swap concurrently).
3. **Run the LHC operation** (compact or prune) on the LHC thread via the capture
   service's SDK instance — expose what's needed from the capture service handle rather
   than constructing a second SDK.
4. **Render** the post-op `getSessionThreadView`.
5. **Quiesce**: stop the thread's active provider session (the persistent Agent SDK
   session holds old context in memory; it must end so the next turn starts from the
   cursor). Use the server's existing stop path; wait for it to settle.
6. **Rebuild**: `writeRebuiltRollout` into the session's Claude projects dir — derive
   the session HOME + cwd from the provider instance / session config the same way the
   adapter does (do not guess paths; read how ClaudeHome shapes it). Source-rollout
   envelope scalars per the findings doc.
7. **Flip the cursor** — the LAST mutating step. Write the persisted resume cursor to the
   new session id in the exact adapter shape. Everything before this point failing =
   thread untouched (old cursor, old rollout still valid; the orphan rebuilt file is
   harmless residue). Flip failing after write = report clearly; old cursor still
   points at the old, still-valid rollout — state this invariant in code where it holds.
8. **Receipt**: write a runtime-note into the LHC record (swap performed: old/new session
   id, op, profile) and return a JSON receipt (op, LHC op result summary, oldSessionId,
   newSessionId, rebuiltPath, timings).

## Endpoints (minimal, curl-driven — no UI)

On the server's existing HTTP surface, same auth posture as existing local routes:

- `GET /lhc/status` — capture service stats() + per-thread context summary (LHC thread
  id, event/turn counts, last activity) for captured threads.
- `GET /lhc/threads/:t3ThreadId` — inspect one thread (overview + health from the SDK).
- `POST /lhc/threads/:t3ThreadId/compact` — body: profile/options passthrough. 409 on
  busy/locked, 404 on no lineage, 500 with structured error + step-reached on failure.
- `POST /lhc/threads/:t3ThreadId/prune` — same shape.
  Endpoints live in lhc-host (a small router/handler module); the server wiring should be
  another contained diff (register routes, pass the service handle) in the style of the
  slice-1.2 wiring.

## Tests (hermetic — no real providers, no paid calls)

- Swap orchestrator with injected step effects (stop/read-cursor/write-cursor/paths):
  happy path ordering (assert cursor flip is last), failure injected at EACH step →
  cursor untouched, lock behavior (same-thread concurrent → rejected; cross-thread →
  parallel), busy check honored.
- Integration: real SDK in temp dir (deterministic callbacks) — intake a few turns, run
  a real compact, real `writeRebuiltRollout` to a temp projects dir, assert the receipt,
  the rebuilt file invariants, and the LHC runtime-note landed.
- Endpoint handlers: status/inspect happy path, 404/409/500 mapping.
  The LIVE swap (real server, real Claude, resume-onto-compacted-context with codename
  recall) is Slice 2.4's job — do not attempt it here.

## Acceptance

- All lhc-host tests green; ClaudeAdapter/ProviderService suites still green if touched;
  `vp run typecheck` + `vp check` green at root.
- Server wiring diff: contained, few files, no lhc-host internals leaking into provider
  code beyond what slice 1.2 already established.
- The cursor-flip-last invariant and the busy/lock semantics explicit in code.
- No `git commit`.

## Report back

Flow implementation summary (how each step maps to server internals you found), the
cursor write mechanism (exact file/API), endpoint surface, test results, any deviation
from the findings-doc recipe with rationale, open risks for 2.4.
