# t3code-lhc implementation plan

Written 2026-07-07. Owner: Lee Moore. Orchestrator: Claude (Fable 5) session; this document is
written so a fresh session can resume orchestration from here plus `impl-log.md` alone.

## Mission

Adapt the LHC SDK (long-horizon context: durable SQLite thread records, derivation pipeline,
smart compact/prune) to **t3code**, a web GUI wrapping coding-agent CLIs. This fork hosts the LHC
SDK inside the t3code server so that:

- every Claude and Codex thread is **captured** into a durable LHC thread as it runs;
- **compact/prune** take effect on the live provider context by rebuilding the provider's rollout
  file from the LHC thread view and swapping the provider session onto it;
- a minimal **control surface** (status / compact / prune / inspect) is exposed from the server,
  driven manually — no real UI in this pass.

This is deliberately a **disposable-on-v1** integration. t3code has an in-flight ground-up
`orchestration-v2` rewrite (branch-only as of 2026-07-07; see Research findings) that replaces the
event stream and adapters this integration rides. We build non-precious on v1 now, learn, and
rebuild v2-native when it lands — at which point v2's `ContextHandoff` becomes the first-class
serving seam.

## Repo layout and workspace

- Workspace: `~/code/t3code-lhc/`
- Fork clone: `~/code/t3code-lhc/t3code` — fork of `pingdotgg/t3code` at
  `https://github.com/liminal-ai/t3code`, remotes: `origin` (fork), `upstream` (pingdotgg).
- **Base commit pin: `6e42231cb1da130069cbc694f9da4a185067a81f`** (upstream main, 2026-07-07).
  Working branch: `lhc`. Strategy: pin, hop upstream versions opportunistically, never
  continuous-rebase. If a hop is painful, stay pinned.
- LHC SDK: linked from its current location,
  `~/code/pi-long-horizon/liminal-context/packages/lhc` (file/link dependency; messy, ratified,
  clean up later). **Deployment constraint:** any machine running this fork (the Linux box) needs
  both repos checked out at the same relative paths, or the link path adjusted.

## Required pre-reading for a fresh orchestrator

1. `liminal-context/docs/onboard/01-core-concepts.md`, `02-domain-design.md`,
   `03-decisions-brief.md` — LHC vocabulary and rulings.
2. `liminal-context/docs/onboard/05-host-cc-lhc.md` — the closest existing host pattern (rollout
   rebuild + swap; we reuse its rebuilder and drop all its PTY machinery).
3. `liminal-context/packages/codex-lhc/docs/implementation-plan.md` and
   `codex-rollout-format-report.md` — codex rollout format + the rebuilder this plan's Phase 4
   depends on.
4. This repo: `docs/architecture/overview.md`, `docs/architecture/providers.md`, and the source
   map in "Research findings" below.

## Research findings the plan rests on (verified 2026-07-07 against this repo at the pin)

### t3code architecture (v1, what we build on)

- Server (`apps/server`) wraps providers behind a driver/adapter SPI
  (`apps/server/src/provider/ProviderDriver.ts`, `provider/Services/ProviderAdapter.ts`). Each
  adapter emits a **normalized event stream** (`streamEvents: Stream<ProviderRuntimeEvent>`) with
  a closed vocabulary (`packages/contracts/src/providerRuntime.ts`): `turn.started/completed/
  aborted`, `item.started/updated/completed` with canonical item types (`user_message`,
  `assistant_message`, `reasoning`, tool lifecycle types), `content.delta`, `model.rerouted`, etc.
  This is the intake tap: **one mapper for both providers**, no rollout tailing needed for capture.
- **Claude** (`provider/Layers/ClaudeAdapter.ts`, ~3.9k lines): wraps
  `@anthropic-ai/claude-agent-sdk` `query()` as a **long-lived streaming session per thread** with
  a prompt queue. Session identity persists as a **resume cursor**
  `{ resume: sessionId, resumeSessionAt?: uuid }` in the `ProviderSessionRuntime` SQLite repo
  (`persistence/ProviderSessionRuntime.ts`). The cursor is only read at session start. Claude Code
  still writes rollout JSONL under the instance's resolved HOME (`Drivers/ClaudeHome.ts`).
- **Codex** (`provider/Layers/CodexAdapter.ts` + `CodexSessionRuntime.ts`): wraps
  `codex app-server` (JSON-RPC/stdio); sessions via `thread/start` / `thread/resume` (falls back
  to fresh start on resume failure, `CodexSessionRuntime.ts:449-476`). Codex writes rollouts under
  a `CODEX_HOME` t3code controls (`Drivers/CodexHomeLayout.ts`, shadow-home mechanism).
- t3code persists its own orchestration event store + projections
  (`persistence/`, `orchestration/`); the web UI renders from projections only. LHC never touches
  UI rendering. Model context, however, is assembled by the **provider engine from its own rollout
  files** on resume — t3code never sends history over the wire. That is why compact must go
  through rollout rebuild + resume, exactly the cc-lhc/codex-lhc pattern, minus the PTY.
- Server state lives under a `stateDir` (`apps/server/src/config.ts`); server has an NDJSON
  provider-event logger (`provider/Layers/EventNdjsonLogger.ts`) — the wire-truth instrument for
  fidelity probes.
- `textGeneration/` runs one-shot generation via provider CLIs (commit messages, titles) — proof
  that subprocess inference lanes coexist fine with the server.

### The orchestration-v2 situation (why disposable-on-v1)

- `orchestration-v2` exists only on upstream feature branches (269 files, Julius Marminge,
  2026-04-20 → 2026-07-03 active). It replaces the v1 event union and all adapters
  (`ClaudeAdapterV2`, `CodexAdapterV2`, …), adds an app-owned replayable event store, thread
  lineage/fork/merge-back, capability system, and `ContextHandoffService` — deterministic
  240-char-truncation summaries injected into runs at provider-switch/fork boundaries. **No
  inference, no compression pipeline, no token accounting, no answer to single-thread context
  growth.** Philosophically aligned with LHC (app-owned record, explicit auditable context
  artifacts, supersede-not-mutate); mechanically a placeholder generator.
- Consequence: v1 main is quiet (~5 commits/14d on `provider/`, ~0 elsewhere relevant) — a stable
  base to hack on. The v1-coupled parts of this integration (mapper, wiring) are consciously
  throwaway; the SDK, rebuilders, inference lane, lineage pattern, and learned UX all carry
  forward to a v2-native rebuild.

### Swap mechanics (established across LHC hosts, adapted here)

- **Claude swap** = LHC compact/prune → rebuild rollout JSONL (cc-lhc `rollout/rebuild.ts`,
  proven in production) into the instance HOME's `~/.claude/projects/<encoded-cwd>/` → flip the
  persisted resume cursor to the new session id → stop the live provider session → next
  `sendTurn` starts a session from the new cursor. No PTY injection, no swap-failure ANSI
  sniffing.
- **Codex swap** = same shape: rebuild rollout into `CODEX_HOME/sessions/YYYY/MM/DD/` → resume by
  new thread id via app-server `thread/resume`. Synthetic rollouts are proven accepted by
  `codex exec resume` (codex-lhc experiments 2026-07-07); app-server `thread/resume` presumably
  shares the loading path — **probe before depending on it** (Slice 4.0).
- Native auto-compact must be suppressed once LHC owns compaction: Codex via
  `model_auto_compact_token_limit` config injection; Claude via Agent SDK/settings auto-compact
  toggle (exact mechanism confirmed in Slice 2.3).

## Standing decisions

| Decision | Ruling | Status |
| --- | --- | --- |
| Scope | Claude Code + Codex only; no LHC support for Cursor/Grok/OpenCode/Copilot in this pass | ratified (Lee, 2026-07-07) |
| Priorities | 1) Claude end-to-end, 2) Codex | ratified |
| Base strategy | Personal fork, pinned at `6e42231cb`; opportunistic version hops; never continuous rebase | ratified |
| Package shape | One new package `packages/lhc-host` in the fork + minimal wiring diffs in `apps/server` (target: ≤ ~4 touch points) so hops stay cheap | ratified pattern |
| SDK consumption | Link `lhc` from `~/code/pi-long-horizon/liminal-context/packages/lhc` (file/link dep). Clean up later | ratified (Lee) |
| State layout | Everything under `~/.t3code-lhc/` (override `T3CODE_LHC_HOME`): `registry.sqlite`, `t3code-lhc.sqlite` (lineage), `threads/<uuid>.sqlite`. **Never** `~/.lhc` — hosts own their state dirs | ratified (Lee) |
| Inference lane | Copy cc-lhc's `claude -p` subprocess provider (`inference/claude-cli.ts` + assignments, Sonnet-no-thinking) verbatim; `--no-inference`-style escape hatch (`T3CODE_LHC_NO_INFERENCE=1`) | ratified (Lee) |
| Intake tap | Normalized `ProviderRuntimeEvent` stream, `item.completed`-based (never deltas). If a payload is lossy: prefer patching the adapter payload in-fork; `raw` field and rollout tailing are fallbacks | proposed; Slice 0.2 decides |
| Capture ordering | Per-thread serialized intake worker; one t3 thread ↔ one LHC thread ↔ one SQLite file. No cross-thread writes to one file | ratified by design |
| SDK instance | One long-lived background-mode `initLhc` instance in the server process | proposed |
| Control surface | Bare HTTP endpoints on the existing server (status/compact/prune/inspect), curl-driven; no web UI this pass | ratified (Lee) |
| Rollback/fork in t3 UI | Out of scope: not LHC-aware. Using t3 rollback on an LHC thread diverges the record; documented, tolerated (runtime-note scar at most) | ratified as accepted risk |
| Idempotency keys | `t3lhc:<threadId>:<eventId-or-itemId>:<kind>`; harness literal `"t3"` | proposed |
| Turn boundaries | From `turn.started`/`turn.completed`/`turn.aborted` events; aborted turns close with a `runtime_note` | proposed |
| v2 rebuild | Explicit non-goal now; revisit when orchestration-v2 merges to upstream main | ratified |

## Delegation model

Lee provides subagent CLI tools (Claude Code, Codex, Cursor); the orchestrator (this session's
successor) plans, briefs, launches, and verifies — it does not generally code or verify by hand.
Model-to-slice assignment happens when tools are granted; every slice below carries a difficulty
tier to make that mapping mechanical:

- **easy / easy-moderate** — mechanical ports, scaffolds, config: default to the fast lane
  (Cursor/Composer-class).
- **hard** — semantic cores, concurrency, swap orchestration: strongest available lane
  (GPT-5.5-high-class or a forked orchestrator clone), with a second model verifying.
- **Verification** on every substantive slice: a different model than the implementer, briefed
  with acceptance criteria, not the implementation.

Every subagent launch, outcome, and next action gets logged in `impl-log.md` at launch/completion
time. Repo gate: `vp check` and `vp run typecheck` must pass before a slice is accepted
(AGENTS.md rule).

## Out of scope (this pass)

Other providers; any web UI beyond curl-able endpoints; t3 rollback/fork awareness; relay/remote
access changes; mobile; orchestration-v2 integration; publishing the SDK; multi-user concerns.

## Phases and slices

### Phase 0 — Scaffold and probes (risk retirement)

Milestone: the fork builds with the SDK linked in, and every load-bearing unknown has a written
answer in `docs/lhc/findings/`.

**Slice 0.1 — package scaffold + SDK link.** *(easy)*
Create `packages/lhc-host` (name `@t3tools/lhc-host`) in the fork: `package.json`, `tsconfig`,
vitest via `vp`, linked `lhc` dependency from liminal-context. Smoke test: `initLhc` in manual
mode with deterministic callbacks creates a thread under a temp dir, intakes a fixture batch,
reads it back via `messages.list`. Acceptance: `vp run typecheck` and `vp check` pass at repo
root; smoke test green; no changes outside the new package.

**Slice 0.2 — probe: event-stream fidelity.** *(moderate; findings doc is the deliverable)*
Run real Claude and Codex sessions through the dev server with the NDJSON provider-event logger
on. Diff `item.completed` payloads against the provider rollout files (Claude: full tool output
known present in rollouts; Codex: same). Answer per provider: does the normalized stream carry
full user/assistant/reasoning text and full tool call+result content? Where it is lossy, name the
field and choose the remedy (in-fork adapter payload widening preferred; `raw`; rollout tail as
last resort). Deliverable: `docs/lhc/findings/event-fidelity.md` + captured NDJSON/rollout fixture
pairs checked into `packages/lhc-host/test/fixtures/`. Acceptance: an explicit mapper tap-point
decision recorded per provider, evidence-cited.

**Slice 0.3 — probe: Claude session restart from flipped cursor.** *(moderate)*
On a scratch thread: stop the active provider session, hand-edit the resume cursor to a rebuilt
rollout file's session id (hand-build a minimal rebuilt file first — cc-lhc's rebuilder as a
library or by hand), send a turn, confirm the Agent SDK session resumes on the rebuilt file and
the planted history reaches the model (codename-recall probe). Also observe interaction with
`ProviderSessionReaper`. Deliverable: `docs/lhc/findings/claude-swap.md`. Acceptance: a verified
step-by-step swap recipe (order of operations, failure behavior when the cursor points at a
missing file).

**Slice 0.4 — probe: multi-thread drain concurrency (bare SDK).** *(hard)*
Test harness in `packages/lhc-host/test/`: one background-mode SDK instance, ~10 threads, concurrent
intake at realistic rates + drains with (a) fake inference callbacks with induced latency, and (b) a
short real `claude -p` smoke. Watch for cross-thread interference, drain starvation, event-loop
stalls, subprocess pile-up. Deliverable: `docs/lhc/findings/concurrency.md` + a recommended global
inference concurrency cap. Acceptance: either "no defects at 10 threads" with evidence, or named
defects filed as blocking items before Phase 1 sign-off.

### Phase 1 — Capture

Milestone: real Claude and Codex sessions run through the (dev) server are fully recorded into
LHC threads — `inspect.overview`/`health` sane, restart-safe, derivations draining.

**Slice 1.1 — mapper + turn accumulator (semantic core).** *(hard)*
`packages/lhc-host/src/intake/map.ts`: `ProviderRuntimeEvent` → ordered LHC intake events, per the
Slice 0.2 tap-point decision. `item.completed(user_message)` → `user_prompt`; `reasoning` →
`assistant_thinking`; `assistant_message` → `assistant_text`; tool lifecycle items → `tool_call`/
`tool_result` (correlated); `turn.completed`/`turn.aborted` → `turn_end` (+ `runtime_note` on
abort); `model.rerouted` → `model_change`; native `context_compaction` items → `runtime_note` +
counter. Tolerant mapper: unknown shapes skip-and-count, never throw. Per-thread turn accumulator
(exactly-one-open-turn contract). Idempotency keys per the standing decision. Fixture-driven tests
from the 0.2 captures covering every canonical item type, both providers, plus sub-agent
(`collab_agent_tool_call`) and interrupt/abort cases. Acceptance: fixtures replayed twice produce
zero duplicates; unknown-event fixture produces skip counts, not errors.

**Slice 1.2 — capture service + lineage + inference lane wiring.** *(moderate-hard)*
`src/capture/`: subscribe to every registered provider instance's `adapter.streamEvents`
(Claude/Codex instances only), route by `threadId` into per-thread serialized intake workers
(`DrainableWorker` pattern), auto-create LHC threads on first sight of a t3 thread, lineage table
(t3 ThreadId ↔ LHC thread id) in `~/.t3code-lhc/t3code-lhc.sqlite`. Copy cc-lhc inference lane
(`claude -p`, concurrency cap from Slice 0.4, `T3CODE_LHC_NO_INFERENCE` escape). Server wiring
diff #1: instantiate the host service in server bootstrap; clean shutdown drains intake workers
and awaits `drainSettled` (capped). Acceptance: unit tests with a scripted event stream; wiring
diff confined to bootstrap; typecheck/check green.

**Slice 1.3 — live capture validation.** *(moderate; verification-heavy)*
Run real sessions on both providers through the dev server: multi-turn, tool-heavy, one
interrupted turn, one sub-agent task. Check `inspect.overview`/`health` per thread (counts sane,
no failed intake, derivations landing). Kill and restart the server mid-session; confirm
idempotency prevents duplicates and leftover queue work drains on reopen. Deliverable: findings
appended to `impl-log.md`. Acceptance: written pass against a checklist of the above cases.

### Phase 2 — Claude compact/prune end-to-end

Milestone: on a long-running Claude thread, an operator hits a prune/compact endpoint and the
next turn provably runs on the compacted context.

**Slice 2.1 — Claude rollout rebuilder integration.** *(moderate)*
Port cc-lhc `rollout/rebuild.ts` + `write-rebuilt.ts` (+ `sessions-index.ts` only if 0.3 showed
the index matters to the Agent SDK) into `src/claude-swap/`, parameterized by the instance's
resolved Claude HOME and cwd encoding. Unit tests against cc-lhc's fixture shapes. Acceptance:
rebuilt file for a fixture thread view is byte-shape-valid per cc-lhc's tests, written fsync'd to
a fresh session id path, original untouched.

**Slice 2.2 — swap orchestration + bare trigger endpoints.** *(hard)*
`src/swap/claude.ts` implementing the 0.3 recipe: turn-gate (refuse while the t3 thread has an
open turn — read t3's own turn state), LHC `prune`/`compact`, rebuild, cursor flip through the
`ProviderSessionRuntime` repo, `stopSession`, receipt. Failure-safe ordering: nothing mutates the
live session until the rebuilt file exists and the cursor flip is the last irreversible step; a
rebuild failure leaves everything running. Server wiring diff #2: bare HTTP endpoints
`POST /lhc/threads/:id/compact`, `.../prune?target=`, `GET /lhc/threads/:id/status`,
`GET .../inspect` on the existing HTTP server, localhost-scoped consistent with existing auth.
Acceptance: on a live dev thread — compact via curl, next turn resumes on the rebuilt session
(codename-recall + rollout file inspection), and a compact attempted mid-turn refuses cleanly.

**Slice 2.3 — Claude native auto-compact suppression.** *(easy-moderate)*
Confirm and implement the mechanism (Agent SDK option / settings / env) in the fork's session
start path, flag-gated. Acceptance: a thread pushed past Claude's native compact threshold shows
no `compact_boundary` in capture while suppression is on.

**Slice 2.4 — end-to-end acceptance run.** *(moderate; verification slice)*
One long dogfood thread on the Linux-box-style setup (server headless, browser remote): capture →
grow past ~100k tokens → prune → compact → continue working. Verify: LHC `status` numbers move as
expected; rebuilt context serves; UI history remains intact (projections untouched by swap);
receipts logged. Deliverable: written acceptance in `impl-log.md`; punch list for Phase 5.

### Phase 3 — Control surface consolidation

Milestone: the endpoints from 2.2 are complete, consistent, and documented — the operator surface
for daily use. *(This phase is small by design; real UI is out of scope.)*

**Slice 3.1 — endpoint completion + receipts.** *(easy-moderate)*
Normalize endpoint I/O (OpResult-shaped JSON errors, receipts with before/after tokens,
degraded/gap reporting from compact receipts), add `GET /lhc/threads` (lineage-joined listing),
document all endpoints with curl examples in `docs/lhc/operations.md`. Acceptance: doc-driven
smoke script exercises every endpoint green against a dev server.

### Phase 4 — Codex

Milestone: same end-to-end story as Phase 2, on Codex.

**Slice 4.0 — probe: app-server `thread/resume` on synthetic rollout + rebuilder dependency
check.** *(moderate)*
Hand-place a synthetic rollout (per the codex-lhc format report) under the instance's
`CODEX_HOME/sessions/`, resume it through t3code's Codex adapter path, codename-recall probe.
Simultaneously: check codex-lhc's rebuilder status in liminal-context — consume it if landed;
otherwise absorb the rebuild slice here (budget grows by roughly its Phase-2.2 slice). Deliverable:
`docs/lhc/findings/codex-swap.md` + a consume-vs-absorb ruling logged in `impl-log.md`.

**Slice 4.1 — Codex rebuilder integration.** *(moderate if consumed; hard if absorbed)*
As 2.1, for codex rollout format into `CODEX_HOME/sessions/YYYY/MM/DD/`, new thread id minted,
registration-by-file-placement per the codex-lhc findings.

**Slice 4.2 — Codex swap orchestration + auto-compact suppression.** *(moderate-hard)*
As 2.2 via the Codex session path (`thread/resume` with the new id; t3code's resume-fallback
must not silently fresh-start — detect and surface). Suppress native auto-compact via
`model_auto_compact_token_limit` injection in the fork's Codex config path, flag-gated.
Acceptance: mirror of 2.2's, plus fallback-to-fresh-start is detected as swap failure, not
silent success.

**Slice 4.3 — Codex end-to-end acceptance run.** *(moderate; verification slice)*
Mirror of 2.4 on a Codex thread.

### Phase 5 — Dogfood and hardening

Milestone: Lee's daily driver on the Linux box. Deliberately unplanned in detail: run it, keep a
punch list in `impl-log.md`, fix in priority order. Known candidates going in: global inference
cap tuning under real load; capture behavior across server restarts with many idle threads;
first upstream version hop as a rehearsal (document the conflict surface against the ≤4 wiring
diffs); decide whether `status` warrants a threshold notification hook.

## Sequencing notes

- 0.2/0.3/0.4 are independent of each other and of 0.1; parallelize across subagents.
- Phase 1 needs 0.1 + 0.2. Phase 2 needs 1.x + 0.3. Phase 4 needs 1.x + 4.0 and is otherwise
  independent of Phases 2–3 (parallelizable if the codex-lhc rebuilder is available early).
- The codex-lhc rebuilder (liminal-context, in progress) is the only cross-repo dependency;
  Slice 4.0 owns the consume-vs-absorb decision so this plan never blocks on it.
