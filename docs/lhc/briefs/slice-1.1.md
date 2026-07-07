# Task: capture mapper + turn accumulator (Slice 1.1 — semantic core)

You are in a t3code fork. Build the mapper that turns t3code's normalized provider events
into LHC intake events, plus the per-thread turn accumulator. This is the semantic core of
the capture layer: correctness and idempotency here decide record quality for everything
downstream. Scope: `packages/lhc-host/src/intake/` only (+ tests + synthetic fixtures).
No server wiring (a later slice subscribes streams and feeds this). No `git commit`.

## Required reading, in order

1. `docs/lhc/findings/event-fidelity.md` — the fidelity ground truth this design rests on,
   including the "(post-patch, this fork)" amendments.
2. `packages/contracts/src/providerRuntime.ts` — the input vocabulary
   (`ProviderRuntimeEvent`, `CanonicalItemType`, `ItemLifecyclePayload`,
   `TOOL_LIFECYCLE_ITEM_TYPES`).
3. In `/Users/leemoore/code/pi-long-horizon/liminal-context` (read-only):
   `packages/lhc/src/intake-stream/index.ts` — `MessageEventInput` shapes, the event-kind
   vocabulary (user_prompt, assistant_text, assistant_thinking, tool_call, tool_result,
   model_change, thinking_level_change, runtime_note, turn_end), idempotency semantics.
   `docs/onboard/02-domain-design.md` — "Intake stream" section: the stream contract
   (ordered events, exactly one open turn, turn_end semantics).
   `packages/cc-lhc/src/intake/map.ts` — a prior mapper for tone: tolerant, skip-and-count,
   never throws.
4. Fixtures: `packages/lhc-host/test/fixtures/event-fidelity/codex/codex-normalized.jsonl`
   and `.../claude/post-patch/claude-normalized.jsonl` — real captured streams you will
   replay in tests.

## Design rulings (already made — implement, don't relitigate)

- **Input:** one `ProviderRuntimeEvent` at a time, per thread; **completed items only** —
  `content.delta` is never a content source (ignore, don't count as unknown).
- **User prompts are captured host-side.** The capture service (later slice) will inject a
  `user_prompt` at sendTurn time for BOTH providers, keyed by **turnId**. Your mapper must:
  (a) expose a function the service calls to build that injected event
  (`userPromptEvent(threadId, turnId, text)` or similar), and (b) ALSO map stream
  `item.completed(user_message)` items (Codex emits them) to `user_prompt` with the SAME
  key shape — LHC idempotency (key wins over content) dedupes the pair. Key:
  `t3lhc:<t3ThreadId>:turn:<turnId>:user_prompt`.
- **Other idempotency keys:** `t3lhc:<t3ThreadId>:<itemId>:<kind>` for item-derived events;
  `t3lhc:<t3ThreadId>:<eventId>:<kind>` for events without items. Deterministic, stable
  across re-tails.
- **Mapping table:**
  - `reasoning` completed → `assistant_thinking` (text from `payload.detail`, falling back
    to `payload.data` shapes seen in fixtures)
  - `assistant_message` completed → `assistant_text` (`payload.detail`; Codex also has
    `data.item.text` — prefer the richer, they matched in fixtures)
  - Tool lifecycle completed items (`command_execution`, `file_change`, `mcp_tool_call`,
    `dynamic_tool_call`, `collab_agent_tool_call`, `web_search`, `image_view`) → a
    `tool_call` event (tool name, args from payload) AND a correlated `tool_result` event
    (output), both from the completed item, correlation id = itemId. Output precedence:
    Claude `data.result.fullOutput` → else preview content (when only path/size metadata
    present, append a one-line `[full output N bytes at <path> not captured]` marker);
    Codex `data.item.aggregatedOutput`. Carry a mechanical outcome (exit code / status)
    where the payload has one.
  - `context_compaction` items → `runtime_note` ("provider-native compaction") + counter.
  - `model.rerouted` → `model_change`.
  - `turn.completed` → (if state is interrupted/failed: first a `runtime_note` naming the
    state and errorMessage) then `turn_end`. Map `turn.aborted` → same shape defensively
    (never observed, per findings).
  - Everything else (`plan`, `review_*`, `error`, `unknown` item types; request/user-input/
    task/hook/token-usage/auth/mcp/config events) → **skip and count by type**. Unknown
    future event types → skip and count. The mapper NEVER throws on strange input;
    malformed payloads increment a `malformed` counter and produce nothing.
- **Turn accumulator** (`turn-accumulator.ts`): per-thread, plain data, enforces the LHC
  stream contract — it decides when `turn_end` is emitted (on turn.completed/aborted),
  tolerates turn.started arriving without a prior close (LHC's user_prompt-closes-open-turn
  handles it; do not synthesize extra turn_ends), and tolerates a process that never sees
  turn.completed (open turn is legal). Keep it a fold over events, no timers.
- **Output:** mapper returns `{ events: MessageEventInput[], skips: Record<string,number> }`
  per input event; a `CaptureStats` accumulator aggregates counters (linesSeen, eventsOut,
  skips by type, malformed) — mirror cc-lhc's stats shape where sensible.

## Tests (fixture-driven; this is where the slice earns acceptance)

- Replay BOTH real fixture streams through the mapper; snapshot the resulting LHC event
  sequences (kinds, keys, correlation ids, turn_end placement). Assert user prompts:
  Codex fixture produces stream-derived user_prompts; Claude fixture produces none from
  the stream (host-side injection covers it — simulate the injection in the test and
  assert the combined sequence).
- Integration test: feed mapped output (plus injected user prompts) into a REAL
  `initLhc` manual-mode instance (pattern: `src/sdk-smoke.test.ts`) in a temp dir; replay
  the same fixture TWICE; assert zero duplicate events, message/turn counts sane
  (`inspect.overview`), exactly-one-open-turn never violated.
- Synthetic fixtures (hand-write, place under `test/fixtures/intake/`): a
  `collab_agent_tool_call` completed item, an unknown item type, an unknown event type,
  a malformed payload (e.g. data of wrong shape), an interrupted turn.completed — assert
  skip/malformed counters and the runtime_note+turn_end pair.
- Claude metadata-only tool output (path/size, no fullOutput) → marker line asserted.

## Acceptance

- `pnpm exec vp run --filter @t3tools/lhc-host test` green; `vp run typecheck` and
  `vp check` green at root.
- Fixture replay ×2 → zero duplicates (proven via the real SDK, not mapper-internal
  bookkeeping).
- No changes outside `packages/lhc-host/`.

## Report back

Design notes (anything where the fixtures forced a choice this brief didn't anticipate),
the mapping table as implemented, test results, deviations.
