# Task: live capture validation (Slice 1.3 — Phase 1 milestone gate)

You are in a t3code fork with LHC capture newly wired in (Slice 1.2). Prove the whole
path works against the REAL server with REAL provider sessions: boot the server, drive
Claude and Codex sessions over the actual WebSocket API, and verify the LHC records.
Deliverable: `docs/lhc/findings/live-capture-validation.md` + a reusable WS driver probe.
No `git commit`. Paid provider calls are authorized (budget ~6-10 sessions; prefer
small/cheap models where selectable; keep tool outputs modest except the one large-output
check).

## Environment hygiene

- Point capture at a scratch home: `T3CODE_LHC_HOME=$HOME/code/t3code-lhc/validation/lhc-home`
  (never the real `~/.t3code-lhc`).
- Run provider sessions in fresh temp git repos (never a real project).
- Kill any server you started when done; note the port you used.

## Setup investigation (do this first, document what you find)

- How to boot the server from this repo headlessly (`pnpm dev:server`, or build + the `t3`
  bin — pick the least-magic path), what port it listens on, and how a non-browser client
  authenticates the WebSocket locally (read `apps/server/src/ws.ts`, `startupAccess.ts`,
  `apps/server/src/auth/`, `packages/contracts/src/ws.ts` + `rpc.ts`; the web app's
  `wsTransport.ts` shows the handshake). If local connections need a token, find where
  it's minted (logs/config) and use it.
- Write the driver as `packages/lhc-host/probes/ws-driver.ts`: connect, welcome handshake,
  `providers.startSession` / `providers.sendTurn` / subscribe to
  `orchestration.domainEvent` pushes to know when a turn completes, `providers.stopSession`.
  Keep it a small library + CLI so Slice 2.x can reuse it.

## Validation checklist (each item gets a PASS/FAIL line in the findings doc with evidence)

1. **Claude multi-turn**: 3 turns in one thread — (a) a prompt eliciting reasoning,
   (b) `seq 1 20000` large tool output, (c) a small file edit. Then verify in the LHC
   record (write a small verify script using the linked `lhc` SDK against the scratch
   home): lineage row exists (t3 thread → LHC thread); `inspect.overview` shows sane
   counts and exactly one open turn; `messages.list/show` contains user prompts (host-side
   injection worked), assistant text, `assistant_thinking` (reasoning captured), and the
   tool result carrying the FULL seq output (not the preview) — cite observed byte length.
2. **Codex multi-turn**: 2-3 turns similar shape. Verify: user prompts present exactly
   once each (stream user_message deduped against host injection — check for doubles!),
   full aggregatedOutput in tool results, turns closed properly.
3. **Interrupt**: start a slow turn (`sleep 120` style prompt) on either provider,
   interrupt via the API; verify runtime_note + turn_end landed and the next turn works.
4. **Derivations drain**: with inference ON (default config — real `claude -p` calls),
   after sessions quiesce check `inspect.health` on both threads: smoothed prompts /
   turn derivations progressing to ready, no failed/blocked pileup, no stuck queue. Note
   observed drain latency roughly.
5. **Mid-session restart**: kill the server process (SIGTERM; note whether shutdown logs
   the capped drain) between turns of a live thread; restart; send another turn to the
   SAME t3 thread (resume path). Verify: lineage resolves to the same LHC thread; no
   duplicate events from any replay (compare event counts before/after; idempotency);
   the new turn's events captured; exactly-one-open-turn still holds.
6. **Stats/logging sanity**: any warnings in the LHC log (`sdk.logging.query`) worth
   flagging; capture stats if reachable (the service exposes stats() but has no endpoint
   yet — reading the sqlite via inspect is enough; note if you found another way).
7. **Kill switch**: boot once with `T3CODE_LHC_DISABLE=1`, run one cheap turn, verify NO
   lhc-home dirs/files are created; boot once with `T3CODE_LHC_NO_INFERENCE=1`, one cheap
   turn, verify capture recorded but no inference children spawned.

## Failure protocol

If an item fails: capture the evidence (logs, record state), mark FAIL with a minimal
repro description, and CONTINUE the checklist unless the failure blocks it. Do not fix
server/package code — findings only (small probe-script fixes are fine). If the server
won't boot or WS auth defeats you after a genuine attempt (~30 min), stop and report what
you learned with exact errors.

## Report back

Findings doc path, PASS/FAIL table up front, per-item evidence, server boot + auth recipe
(for reuse), costs observed, deviations.
