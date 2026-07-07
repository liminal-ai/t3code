# LHC Phase 2 live acceptance run (Slice 2.4)

First real end-to-end execution of the full LHC compact/prune loop against the
**real** server driven over the **real** WebSocket API with **real** Claude
(haiku) sessions, exercising the `/lhc` HTTP endpoints. Everything under test was
already built (capture — Slice 1.3; Claude rollout rebuilder — 2.1; swap
orchestration — 2.2; `/lhc` endpoints + auto-compact suppression — 2.3/2.2).

- **Date:** 2026-07-07
- **Scratch LHC home:** `~/code/t3code-lhc/validation/lhc-home-p2` (+ `-ctrl` for
  the suppression control). The real `~/.t3code-lhc` was never touched.
- **Server base dir:** `~/code/t3code-lhc/validation/t3home-p2`, **port 4601**,
  host `127.0.0.1` (control server: `t3home-p2-ctrl`, port 4602).
- **Provider:** Claude `claude-haiku-4-5` for every turn; fresh temp git repos
  under `~/code/t3code-lhc/validation/repos/*` as cwd. Real `~/.claude/projects`
  holds the rollouts (as in the 0.3 swap probe).
- **No `git commit` was made.** New files: `packages/lhc-host/probes/phase2-acceptance.ts`,
  `packages/lhc-host/probes/control-autocompact.ts`, and this doc.

## Result summary

| #   | Item                                  | Result      | Headline evidence                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Grow (seed facts → large tool output) | **PARTIAL** | Seed facts set & retained; LHC captured full output (**tool_result 528,927 B**, `viewStatus.tailTokens` **940,055**, `compactRecommended:true`). But **provider `usedTokens` peaked 33,793**, not ≥60k — Claude Code truncates in-context tool output; large prompts don't move it either. Root-caused below. |
| 2   | Status surfaces                       | **PASS**    | `GET /lhc/status` → 200 (capture stats + threads with sane counts); `GET /lhc/threads/:id` → 200 overview+health+viewStatus; derivations mostly ready (30/35 at capture, drained to 62/62).                                                                                                                   |
| 3   | Compact                               | **PASS**    | `POST …/compact` → 200 full receipt (old/new session id, `rebuiltPath`, `rebuilt`, `cursor`, `timings.total`=169 ms, `runtimeNote.recorded:true`); rebuilt file exists; persisted cursor `resume` == new session id.                                                                                          |
| 4   | Resume onto compacted context         | **PASS**    | Recall **correct** (`codename=COPPER-IBIS-42 lucky=7391`, unrestated); resumed from the **rebuilt** id (fresh `parentUuid:null` chain, cursor names new id, new turn appended to rebuilt file). Provider token drop modest (33,793→28,813); LHC-view drop large (940k→rebuilt 2 lines).                       |
| 5   | Continuity                            | **PASS**    | 2 more turns append to the **same** LHC thread `th_9bfdfb618f70d7de` (no new lineage row); events 44→57→66; rebuilt rollout grew 11→21 lines.                                                                                                                                                                 |
| 6   | Auto-compact suppression (2.3 proof)  | **PARTIAL** | Suppressed run: `compactsAutomatically:false` throughout; **0 `compact_boundary`** lines in any rollout. But the SUPPRESS=0 **control also reported `false`** — no live differential observable (context peaked at 17% of the 200k window, far below the native trigger).                                     |
| 7   | Prune                                 | **PASS**    | `POST …/prune` → 200 receipt (chained swap, rebuilt 12 lines, `timings.total`=71 ms, `runtimeNote.recorded:true`); next turn `ready`; record intact.                                                                                                                                                          |
| 8   | Error surfaces                        | **PASS**    | Unknown thread → **404 `not_captured`** (`stepReached:resolve-lineage`); compact during in-flight turn → **409 `busy`** (`stepReached:busy-check`, session confirmed `running`). Second-in-flight compact skipped (timing-fragile).                                                                           |
| 9   | Sanity sweep                          | **PASS**    | LHC logs 0 warnings; derivations fully drained (62/62 ready, queue {0,0}, 0 failed); status endpoint stats clean (eventsSeen 438, ignored 0); no LHC errors in server log.                                                                                                                                    |

**7 PASS, 2 PARTIAL, 0 FAIL.** No blocking failures. Both PARTIALs are the same
root cause: the provider's reported context-window usage cannot be driven to a
large value in this harness, so neither the ≥60k target (item 1) nor the native
auto-compact trigger (item 6 control) could be reached. The compact/prune/resume
machinery itself works end-to-end and is fully validated.

Runs: **run2 (seq growth)** is the primary citation (t3 `8cc680c7…` → LHC
`th_9bfdfb618f70d7de`); **run1 (seq)** (t3 `6dcf7056…` → `th_ffdcdc532f52eca0`)
and **run3 (large-prompt growth)** (t3 `7d02598e…`) corroborate; **control**
(SUPPRESS=0, port 4602) for item 6.

---

## Server boot + WS auth + curl recipe (as used)

Reused verbatim from Slice 1.3 (`live-capture-validation.md`). Boot from source
under the resolve hook; mint a bearer in-process; curl `/lhc` with that bearer.

```sh
export T3CODE_LHC_HOME=$HOME/code/t3code-lhc/validation/lhc-home-p2   # NEVER ~/.t3code-lhc
export BASE=$HOME/code/t3code-lhc/validation/t3home-p2

# 1. boot (suppression defaults ON; the only gate is T3CODE_LHC_DISABLE)
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  apps/server/src/bin.ts serve --port 4601 --base-dir "$BASE" --host 127.0.0.1
#   -> writes $BASE/userdata/server-runtime.json {origin,port,pid,…}

# 2. mint a reusable bearer (shares this node + resolve-hook invocation)
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  packages/lhc-host/probes/ws-scenario.ts auth --base-dir "$BASE" --out "$BASE/driver-auth.json"

# 3. curl the /lhc endpoints with that bearer (same scopes as other raw routes:
#    GET needs orchestration:read, POST needs orchestration:operate — the minted
#    bearer carries both).
TOK=$(node -e "console.log(require('$BASE/driver-auth.json').accessToken)")
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:4601/lhc/status
curl -s -H "Authorization: Bearer $TOK" http://127.0.0.1:4601/lhc/threads/<t3ThreadId>
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4601/lhc/threads/<t3ThreadId>/compact
curl -s -X POST -H "Authorization: Bearer $TOK" -H 'content-type: application/json' \
  -d '{}' http://127.0.0.1:4601/lhc/threads/<t3ThreadId>/prune
```

The full flow was driven by `probes/phase2-acceptance.ts` (WS driver from Slice
1.3's `ws-driver.ts` for turns; `fetch` with the bearer for the endpoints; token
usage + recall answer parsed from the subscribeThread stream and the rebuilt
rollout). It writes a single JSON journal:

```sh
node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
  packages/lhc-host/probes/phase2-acceptance.ts \
  --auth "$BASE/driver-auth.json" --repo "$V/repos/p2-run2" --out "$V/phase2-journal.json" \
  --grow-mode seq --grow-seq 15000 --target-tokens 60000 --min-grow 4 --max-grow 6
```

Persisted cursor read (item 3): `provider_session_runtime.resume_cursor_json` in
`$BASE/userdata/state.sqlite`:

```sh
sqlite3 -json "$BASE/userdata/state.sqlite" \
  "SELECT thread_id, resume_cursor_json, runtime_payload_json FROM provider_session_runtime;"
```

---

## Context-usage numbers (before/after) — the central finding

The task's item-1 bar ("≥60k tokens by the provider's token-usage events") was
**not reachable in this harness**, and understanding why is the most important
result of this run.

**The provider's `usedTokens` (from `thread.token-usage.updated` →
`context-window.updated`) plateaus around a Claude-Code baseline and cannot be
grown much past it here:**

| turn (run2, seq)     | seq size | provider `usedTokens` |
| -------------------- | -------- | --------------------- |
| seed (`noted`)       | —        | **25,893**            |
| grow 1               | 15,000   | 27,195                |
| grow 2               | 30,000   | 28,494                |
| grow 3               | 45,000   | 29,795                |
| grow 4               | 60,000   | 31,196                |
| grow 5               | 75,000   | 32,494                |
| grow 6               | 90,000   | **33,793** (peak)     |
| after compact+resume | —        | **28,813**            |

Provider context window `maxTokens` = **200,000**, so the 33,793 peak is only
~**17%** of the window.

Three empirical facts explain the plateau:

1. **~26k is Claude-Code baseline** — the seed turn (a one-word reply, no tool
   output) already reports 25,893. That is the `claude_code` system-prompt +
   full tool/MCP definitions, not our data.
2. **Bash tool output is truncated in-context and dropped on the next turn.**
   `seq 15000` and `seq 90000` (a 6× size range) yield nearly identical
   `usedTokens` (27,195 vs 33,793). Each turn adds only ~1.3k regardless of
   size; prior turns' large tool_results are evicted. (run1 replicated this.)
3. **Large user prompts don't move `usedTokens` either.** run3 fed 45k/90k/135k-
   token reference blocks as user prompts; `usedTokens` stayed at baseline
   (`overallPeak` 25,910). Prompt caching / active-token accounting keeps the
   reported snapshot flat.

**LHC, by contrast, captured the full content.** On the same run2 thread:
`messages.list` shows a **528,927-byte** tool_result (the full `seq 90000`
output — untruncated), and `GET /lhc/threads/:id` `viewStatus` reports
`tailTokens: 940,055`, `threshold: 160,000`, **`compactRecommended: true`**. So
LHC "sees" ~940k tokens of real content while the provider's live context is
~34k — exactly the fidelity gap LHC exists to close.

**Item 4 drop, two ways:** provider `usedTokens` 33,793 → 28,813 (a real but
modest ~15% drop, because ~26k is unremovable baseline); LHC view: the old
session rollout was 69 lines / 300 KB, the rebuilt (compacted) rollout is **2
lines** and `viewStatus.tailTokens` collapses from 940k. The _material_ drop is
real; it is only visible in LHC's own accounting, not the provider's baseline-
dominated counter.

---

## Per-item evidence

### 1. Grow — PARTIAL

Seed turn 1 planted `COPPER-IBIS-42` + lucky number `7391`; then 6 escalating
`seq` turns (15k→90k). Both facts were retained and recalled post-compact (item
4). LHC captured everything at full fidelity (528,927-byte tool_result;
`tailTokens` 940,055; `compactRecommended:true`; derivations drained 62/62).
**The ≥60k-by-provider-token-usage bar was not met** (peak 33,793) for the
reasons above — this is a harness/provider limitation, not an LHC defect. Cited
peak: **33,793** provider `usedTokens` / **940,055** LHC `tailTokens`.

### 2. Status surfaces — PASS

`GET /lhc/status` → 200:
`capture:{enabled:true, mode:"background", eventsSeen:363→438, eventsIgnored:0}`
and a `threads[]` with sane per-thread `{eventCount, turnCount, lastActivityAt}`.
(Notably, the capture `stats()` surface that Slice 1.3 found _unreachable_ is now
exposed here.) `GET /lhc/threads/:id` → 200 with `overview`
(`byKind {user_prompt:7, assistant_thinking:7, tool_call:8, tool_result:8,
assistant_text:7}`, `turns {open:1, closed:7}`), `health` (`failures:[]`), and
`viewStatus`. Derivations were mostly ready at capture time (`ready:30, pending:5,
failed:0`) and fully drained by end of run (62/62 ready, queue {0,0}).

### 3. Compact — PASS

`POST …/compact` (default profile, `{}` body) → **200**. Receipt (run2):

```
op=compact  oldSessionId=7341ba66…  newSessionId=1989f3c0…
rebuiltPath=~/.claude/projects/-Users-…-p2-run2/1989f3c0-….jsonl
rebuilt={lineCount:2, expectedReintakeLines:2, replayedPrefixLines:1}
cursor={threadId:8cc680c7…, resume:1989f3c0…, turnCount:6}
timings={quiesce:130, resolve-paths:15, rebuild:10, cursor-flip:1, …, total:169}ms
runtimeNote={recorded:true}
```

`stepReached` is absent on success (it is only populated on `ClaudeSwapError`).
The rebuilt file exists at `rebuiltPath` (2 lines, first line
`type:user, parentUuid:null, sessionId:1989f3c0…` — a fresh uuid chain rooted at
the new session id). The persisted cursor names the new session id: run1's live
`resume_cursor_json` read `{resume:"f8ba2a05…", turnCount:2}` (the rebuilt id),
and run2's receipt `cursor.resume` == `newSessionId` == `1989f3c0…`.

### 4. Resume onto compacted context — PASS

Next turn asked for the codename + lucky number **without restating them**. The
assistant answered, from the rebuilt rollout (authoritative — the text Claude
actually wrote): **`codename=COPPER-IBIS-42 lucky=7391`** (both correct;
reproduced identically in run1 and run3). Session-provenance evidence that it
started from the **rebuilt** id (not fresh, not old):

- the rebuilt rollout is a fresh `parentUuid:null` chain whose `sessionId` is the
  new id, and the resume turn's user+assistant lines were **appended to that
  file** (2 → 11 lines), not to the 300 KB old-session file;
- the persisted cursor `resume` names the new id;
- neither silent-swap tell from the 2.2 audit appeared — **no
  `missing_source_rollout`** error, and **no first-turn "No conversation found"**
  failure (the turn settled `ready`).

A fresh session could not have recalled the codename; the old id would have
appended to the big rollout. Token drop: 33,793 → 28,813 (see the numbers
section — modest provider-side, large LHC-side).

The rebuilt rollout also carries a `[context · smooth]` line preserving the seed
facts and a `[runtime note]` recording the swap
(`session dd7c2447… preserved; resumed in-place as f8ba2a05…`).

### 5. Continuity — PASS

2 more small turns (`ok`). Capture kept appending to the **same** LHC thread
`th_9bfdfb618f70d7de` (lineage id identical across before/after/final inspects —
**no new lineage row**); `overview.events` grew 44 → 57 → 66; `byKind` user_prompt
7 → 10, assistant_text 7 → 10; the rebuilt rollout file grew 11 → 21 lines.

### 6. Auto-compact suppression — PARTIAL

- **Positive (suppressed, default boot):** every `context-window.updated`
  snapshot across all runs reported `compactsAutomatically:false` (distinct set
  `[null, false]`, never `true`); scanning **all 8 rollout files** across the
  three run repos found **0 `compact_boundary`** lines.
- **Control (`T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0`, port 4602, one turn):**
  **also reported `false`** (`compactsAutomaticallyValues [null,null,false]`).
  Env was verified on-process (main server: SUPPRESS unset → suppression ON;
  control: `T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0`) — so this is not an env bug.

Because the field is `false` in **both** configs, this run cannot use it to prove
the flag changed behaviour. Root cause: context peaked at ~17% of the 200k
window, far below where Claude Code's native auto-compact would trigger, so
`isAutoCompactEnabled` reports `false` and no `compact_boundary` would appear
regardless of the setting. The suppression **code path is applied** (ClaudeAdapter
sets `settings.autoCompactEnabled:false` only when the flag is on,
`ClaudeAdapter.ts:3573`), but no _live behavioural differential_ was observable.
Marked PARTIAL rather than PASS to avoid overclaiming.

### 7. Prune — PASS

`POST …/prune` (`{}` body) → **200**. Receipt (run2): `op=prune`,
`old=1989f3c0…` (the compact's _new_ session — a chained swap on the already-
compacted thread), `new=f599291e…`, `rebuilt={lineCount:12, …}`,
`timings.total=71 ms`, `runtimeNote.recorded:true`. The next turn returned
`ready`; the pruned rollout file exists and grew to 21 lines. Record intact.

### 8. Error surfaces — PASS

- **Unknown thread** → **404** `{ok:false, error:{code:"not_captured",
stepReached:"resolve-lineage", retriable:false}}`.
- **Busy** (compact fired ~2 s into an in-flight slow turn) → **409**
  `{code:"busy", stepReached:"busy-check", retriable:true}`; the monitor
  confirmed the session was `running` with a non-null `activeTurnId` at fire
  time. Reproduced in both run2 and run3.
- **Second compact while one is in flight** (`swap_in_progress`, 409): **skipped**
  — the swap completes in <200 ms (see timings), so racing a second request into
  the swap window is timing-fragile; the busy guard above already demonstrates
  the concurrency rejection. Noted per the "skip if flaky" allowance.

### 9. Sanity sweep — PASS

`sdk.logging.query` on the primary thread: **0 entries, 0 warnings/0 errors**.
Derivations fully drained: `ready:62, pending:0, retrying:0, failed:0, blocked:0`,
`health.failures:[]`, queue `{queued:0, claimed:0}`. Capture stats via the status
endpoint clean (`eventsSeen:438, eventsIgnored:0`). Server log (65 lines) has no
`lhc` / `claude-swap` / `drain` / `intake` / `lineage` error or warning lines.
`maxToolResultBytes 528,927` confirms full-fidelity capture with zero loss.

---

## Deviations

- Ran **3 full-flow threads** (+1 control turn) vs the single-thread ideal: run1
  (seq, fixed size) crashed at the busy step on two probe bugs (`Effect.catchAllCause`
  doesn't exist in this `effect` beta; assistant-answer extraction returned `""`),
  which I fixed in the probe (not in product code) before run2/run3. run1's
  happy-path had already succeeded and its live cursor read is cited for item 3.
- Added a **large-user-prompt grow mode** (run3) to try to reach ≥60k a second
  way; it confirmed large prompts don't move `usedTokens` either.
- Item-1 grow strategy escalates single-turn seq size rather than accumulating,
  after run1 showed context does not accumulate across turns.

## Costs observed

- **Provider turns:** ~35 across 3 threads + control, all `claude-haiku-4-5`.
  Cheap. run3's three large reference-block prompts (45k/90k/135k tokens, re-sent
  cumulatively) were the biggest single provider input (~450k haiku input tokens
  total).
- **Inference-lane derivations (dominant cost):** inference ON (default), so each
  captured turn triggered real `claude -p` `smoothed_prompt` + `tool_result_summary`
  calls **on `claude-sonnet-5`** (from `ccAssignments`, not operator-selectable),
  including summaries over the 300–528 KB `seq` tool_results — the per-turn cost
  driver, same as flagged in Slice 1.3.
- **Rough total estimate: ~$5–10**, dominated by the sonnet inference lane.

## Cleanup

- Control server (port 4602) killed after item 6. The main server (port 4601,
  pid 46757) is killed at the end of this run. All scratch state is under
  `~/code/t3code-lhc/validation/` (outside the repo); the real `~/.t3code-lhc`
  and `~/.claude` config were untouched (rollouts landed in `~/.claude/projects`
  under the scratch-repo cwds, as designed).

---

## For Phase 3 to absorb

1. **Provider `usedTokens` is not a usable "grow the context" lever in a test
   harness.** It is baseline-dominated (~26k Claude-Code system+tools) and capped
   by in-context tool-output truncation + eviction; large prompts don't raise it.
   Any future large-context compaction test must assert on **LHC's own view
   accounting** (`viewStatus.tailTokens`, `compactRecommended`) — which correctly
   reached 940k — not on the provider's counter. Consider surfacing
   `tailTokens`/`compactRecommended` as the acceptance metric.
2. **Item-6 suppression needs a real positive control.** Two options: (a) drive
   in-context tokens to the native auto-compact trigger (~80–90% of the 200k
   window) so `compactsAutomatically` flips to `true` with SUPPRESS=0 and a
   `compact_boundary` appears — expensive and hard given truncation; or (b) assert
   directly on the SDK query `settings.autoCompactEnabled` value the adapter
   passes (unit/integration level), which is deterministic. Also worth confirming
   whether the Agent SDK's _default_ auto-compact is already off (which would make
   the flag belt-and-braces, as `flags.ts` already hints).
3. **Swap is fast (<200 ms).** The `swap_in_progress` 409 path is real in code but
   hard to hit live; cover it with a deterministic test that holds the swap open,
   rather than racing it.
4. **Probe robustness:** the streaming assistant-answer extraction from
   `thread.message-sent` returned empty; the rebuilt-rollout parse was the
   reliable source. If Phase 3 reuses `ws-driver`, prefer reading answers from the
   LHC capture / rollout over the streaming events.
5. **Chained swaps work** (compact → prune on the same thread re-swaps cleanly),
   and capture keeps a single stable lineage across swaps — good to keep asserting
   as the loop matures.
