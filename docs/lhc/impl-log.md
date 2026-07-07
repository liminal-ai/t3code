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

## 2026-07-07 — Slices 1.0 (ClaudeAdapter fidelity patch) and 1.2a (inference lane) done

- status: done
- who: 1.0 Fable high (run -181ff4, 21.7m), verified GPT-5.5 high (REVISE: byte-cap
  enforcement → fixed via stat+Buffer.byteLength, 62/62 adapter tests → converged; Patch 2
  ACCEPT outright). 1.2a Composer (run -e446ca, 4.4m), verified GPT-5.5 high (ACCEPT; zero
  parity findings; orchestrator closed the sandbox-blocked test run: 16 passed).
- what: **1.0** — in-fork ClaudeAdapter patches: (1) completed tool items now carry
  `payload.data.result.fullOutput` read from the Agent SDK sidecar (10MB byte cap enforced
  on reported size, stat size, and read bytes; failures degrade to path/size metadata;
  never throws into the pipeline; path trusted as local sidecar metadata — accepted risk).
  (2) Reasoning fixed at root cause: `content_block_start` ignored `thinking` blocks;
  now `reasoning` items with `reasoning_text` deltas + completed lifecycle; snapshot
  backfill filtered to assistant blocks. Post-patch fixtures under
  test/fixtures/event-fidelity/claude/post-patch/ (fullOutputSize 108894; two reasoning
  pairs); findings doc amended "(post-patch, this fork)"; pre-patch record intact.
  3 new adapter tests; probe gained --thinking/--turns flags.
  **1.2a** — cc-lhc `claude -p` inference lane ported near-verbatim (assignments.ts
  byte-identical): env prefix T3CODE*LHC*\*, default concurrency 8 per concurrency
  findings, 5 documented toolchain adaptations (effect-diagnostics pragmas, namespace
  node imports, erasableSyntaxOnly constructor, oxfmt, claude-bin.ts). 12 hermetic tests
  - fake-claude.mjs ported.
- ruling: user prompts will be captured host-side at sendTurn for BOTH providers, keyed
  by turnId, so Codex's stream user_message items dedupe against them via LHC idempotency
  (key wins over content).
- next: Slice 1.1 (mapper + turn accumulator, GPT-5.5 high).

## 2026-07-07 — Slice 1.1: mapper + turn accumulator done

- status: done
- who: GPT-5.5 high (run -db502f, 8.1m; revision -ba9e88, 3.2m), verified Fable high
  (run -f9a4e0: ACCEPT with 5 findings, all addressed → converged)
- what: `packages/lhc-host/src/intake/` — tolerant mapper (ProviderRuntimeEvent → LHC
  intake events), pure-observer turn accumulator, capture stats. Dedupe linchpin verified:
  stream-derived and host-injected user_prompts share one key builder
  (`t3lhc:<threadId>:turn:<turnId>:user_prompt`); replay-twice through the real SDK proves
  zero dupes ({open:1,closed:3} Codex / {open:1,closed:2} Claude). Tool outputs verified
  full (Claude fullOutput, Codex aggregatedOutput) with metadata-only marker fallback.
  Revision: TOOL_LIFECYCLE_ITEM_TYPES now imported from @t3tools/contracts (runtime-value
  drift = silent capture loss); context_compaction + user_message_no_turn coverage added;
  known limits documented in-code (same-turnId content drop by key-wins design;
  eventId-key stability bounded to re-tails of the persisted stream).
- next: Slice 1.2 — capture service + lineage + server bootstrap wiring (Fable codes,
  GPT-5.5 verifies). 1.2a (inference lane) already landed.

## 2026-07-07 — Slice 1.2: capture service + lineage + server wiring done

- status: done
- who: Fable high (run -e532b7, 26.3m; revision -c2afc5, 9.8m), verified GPT-5.5 high
  (run -981244: REVISE, 7 findings, all fixed → converged; orchestrator ran the
  sandbox-blocked gates: lhc-host 36 passed, ProviderService 28/28, typecheck+check green)
- what: `packages/lhc-host/src/` — paths/config (~/.t3code-lhc, T3CODE_LHC_HOME/
  \_DISABLE/\_NO_INFERENCE), lineage (t3 ThreadId → LHC thread, file-then-row, race
  converges), capture service (one background SDK; subscribes ProviderService.streamEvents
  — the server's reconciled fan-in, so hot-added instances covered; per-thread unbounded
  FIFO with 10k watermark warning + lazy idle eviction; fail-soft intake; stop() fully
  capped at 30s with child-kill in finally), server layer (subscription attached via
  Stream.toPull before service yields). Server diff: ProviderService.ts +~40 (turn-started
  observer hook w/ disposer + forwarding-fiber catchCause hardening), server.ts +24,
  package.json +1 dep. Verifier confirmed fan-in fidelity: unbounded PubSub, no
  trimming/suppression — only providerInstanceId canonicalization.
- next: Slice 1.3 — live capture validation on this Mac (orchestrator-driven): boot dev
  server, real Claude+Codex sessions via a WS driver, inspect checks, mid-session restart.

## 2026-07-07 — Slice 1.3: live capture validation — PHASE 1 COMPLETE

- status: done (all 7 checklist items PASS)
- who: Fable high (run -c1c632, 40.6m; envelope errored on the final message but all work
  completed and verified on disk — findings doc written, servers cleaned up)
- what: docs/lhc/findings/live-capture-validation.md. Real server (port 4599, scratch
  T3CODE_LHC_HOME) driven over the real /ws API. Claude 3-turn: reasoning + full 108,927-
  byte tool result + host-injected prompts all in the LHC record, 14/14 derivations
  ready. Codex 3-turn: no prompt-dedupe doubles, full aggregatedOutput. Interrupt →
  runtime_note + closed turn. Real claude -p drain ~2-3s/turn. Mid-session server restart
  → same LHC thread, exactly +4 events, zero replay dups. Kill switches proven both ways
  (DISABLE creates nothing; NO_INFERENCE captures with zero inference children, positive
  control confirms detector). Reusable ws-driver.ts/ws-scenario.ts/verify-lhc.ts probes
  landed for Phase 2, including the server-boot + WS-auth recipe in the findings doc.
- next: Phase 2 — Slice 2.1 (cc-lhc rebuilder port, Composer) and 2.3 (auto-compact
  suppression, Composer) are parallelizable; then 2.2 (swap orchestration + endpoints,
  GPT-5.5).

## 2026-07-07 — Slices 2.1 (rebuilder port) and 2.3 (auto-compact suppression) done

- status: done
- who: both Composer (runs -b10095 2.8m, -bb2ed8 16.5m; 2.3 revision -37588d 0.9m),
  both verified GPT-5.5 high (2.1 ACCEPT no drift; 2.3 REVISE→flags.ts hygiene→converged)
- what: **2.1** — cc-lhc rollout rebuilder ported to packages/lhc-host/src/claude-swap/
  (rebuild/write-rebuilt/types): sessions-index pipeline stripped per 0.3 findings,
  claudeProjectsDir parameterized, realpath-encoded cwd feeds both path and envelope,
  RebuildRolloutInput seam preserved for the future codex mirror; new integration test
  rebuilds from a REAL getSessionThreadView. **2.3** — Claude native auto-compact
  suppressed per-session via SDK options.settings.autoCompactEnabled:false (flag-settings
  layer overrides user/project; field verified in sdk.d.ts). Flag
  T3CODE_LHC_SUPPRESS_AUTOCOMPACT default-on, forced off under T3CODE_LHC_DISABLE, opt-out
  =0/false. Lean src/flags.ts (side-effect-free) exported as ./flags so the adapter
  doesn't pull the inference lane. Live proof deferred to 2.4 (check: no compact_boundary,
  compactsAutomatically:false, control run with suppression off).
- also: fixed 2 lint errors in 1.3 probe files (namespace-node-imports) that had slipped
  past the gate — orchestrator process note: re-run vp check before every commit, and
  delegate even trivial fixes.
- next: Slice 2.2 — swap orchestration + endpoints (GPT-5.5 high), the Phase 2 core.

## 2026-07-07 — Slice 2.2: Claude swap orchestration + control endpoints done

- status: done
- who: GPT-5.5 high (run -3ed3f6, 12.9m; revision -620258, 7.2m), verified Fable high
  (run -7a93da, 10.4m: REVISE — 2 findings + polish, all fixed → converged; orchestrator
  ran full gates: lhc-host 59 passed, server suites 97 passed, typecheck+check green)
- what: packages/lhc-host/src/swap/claude.ts — full flow: lineage resolve → busy check +
  per-thread swap lock → LHC compact/prune on capture's SDK → post-op view →
  stopSession quiesce → writeRebuiltRollout (HOME from continuationKey for explicit
  homes; NEW ClaudeSwapHome.ts aligns default-home with process.env.HOME + realpath) →
  cursor flip LAST via ProviderSessionDirectory.upsert {threadId, resume, turnCount}
  (merge semantics confirmed; uuid validated both ends) → runtime-note receipt.
  Window B contested-flip guard: pre-flip active-session abort + post-flip cursor
  re-read with retry-once-when-idle; contested = structured 409 flip_contested,
  NEVER a lying success receipt. Window A documented (interrupted turn survives in LHC
  record, drops from resumed context — accepted v1). HTTP: GET /lhc/status,
  GET /lhc/threads/:id, POST /lhc/threads/:id/{compact,prune} behind the same
  authenticateRawRouteWithScope as neighboring routes; 404/409/503/500+stepReached.
- open risks for 2.4 (from verifier): server-wiring path is statically verified only —
  2.4 is its first real execution; watch for missing_source_rollout and first-turn
  "No conversation found" as the silent-swap tells; don't send turns mid-swap.
- next: Slice 2.4 — live acceptance run (compact a real >100k thread, verify resume onto
  compacted context + codename recall + auto-compact suppression live proof).

## 2026-07-07 — Slice 2.4: live acceptance run — PHASE 2 COMPLETE

- status: done (7 PASS, 2 PARTIAL, 0 FAIL)
- who: Fable high (run -4bcfb3, 27.7m), orchestrator-accepted (acceptance run IS the
  verification). Cost ~$5-10, dominated by the sonnet inference lane.
- what: docs/lhc/findings/phase2-acceptance.md. THE CORE LOOP IS PROVEN LIVE: grow real
  Claude (haiku) thread → POST /lhc/threads/:id/compact → 200 receipt → cursor names
  rebuilt session id → next turn resumes FROM THE REBUILT ID and recalls
  codename+fact from turn 1 → 2 more turns append to same LHC thread/rollout → prune
  also round-trips. 404/409-busy surfaces correct. Neither silent-swap tell appeared.
  Zero LHC warnings; derivations drained.
- PARTIALs (shared root cause, not defects): (1) provider usedTokens plateaus ~34k in a
  synthetic harness — Claude Code truncates/evicts tool output in-context, while the LHC
  record carried the full 528,927-byte tool_result and tailTokens 940,055 with
  compactRecommended:true — exactly the fidelity gap LHC exists to close. (2) the
  suppression control also read compactsAutomatically:false because this box's user
  ~/.claude/settings.json already sets autoCompactEnabled:false — suppression is
  redundant HERE but unit-verified for boxes where the user setting is true; native
  compact_boundary never appeared in any run.
- phase-3 absorb list: assert on LHC tailTokens/compactRecommended in large-context
  tests; integration-level assert of settings.autoCompactEnabled for the control;
  deterministic swap_in_progress coverage.
- next: Phase 3 (endpoint consolidation + operations doc — small), then Phase 4 (Codex:
  4.0 synthetic thread/resume probe first).

## 2026-07-07 — Slice 3.1: endpoints + hardening + operations doc — PHASE 3 COMPLETE

- status: done
- who: Composer (run -e516a8, 2.9m; doc revision via resume), verified GPT-5.5 high
  (run -fa76c9: code/tests ACCEPT; REVISE on 4 ops-doc accuracy items → fixed →
  converged; orchestrator ran gates: 60 passed, typecheck+check green)
- what: GET /lhc/threads/:id now surfaces tailTokens + compactRecommended top-level;
  /lhc/status carries per-thread pending/pendingHigh (hot-state semantics documented).
  Deterministic swap_in_progress test (gated quiesce, racing second request → 409,
  release → first completes). Suppression integration assert confirmed already covered
  (ClaudeAdapter.test.ts:688-763). viewStatus assertions added to swap integration test.
  docs/lhc/operations.md: state layout, env flags (incl. T3CODE_LHC_CLAUDE_BIN), boot
  recipe, curl book w/ full error table, troubleshooting (silent-swap tells, drain
  issues), known limits — verifier-audited line-by-line against code.
- next: Phase 4 — Slice 4.0 (codex synthetic thread/resume probe, the last structural
  unknown), then 4.1 rebuilder + 4.2 swap orchestration + 4.3 acceptance.
