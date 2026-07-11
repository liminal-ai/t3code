# Cursor + Grok ACP capture fidelity

## Executive ruling

Widening `CAPTURED_DRIVER_KINDS` is **not sufficient**. The current filter is still exactly
`["claudeAgent", "codex"]`, and non-members are discarded before mapping
(`packages/lhc-host/src/capture/service.ts:26,442-459`). With the filter hypothetically widened:

- host-known user prompts and normal turn boundaries would be captured;
- assistant text would be completely absent from LHC for both providers;
- tool status would survive, but `tool_result.content` would contain only a 32-byte status marker;
- Cursor's full output bytes would remain stranded in `tool_call.arguments.rawOutput.stdout`;
- Grok's full output could not be recovered from the event stream because ACP itself supplied only
  a truncated preview.

The minimum capture-safe combination is an LHC mapper delta accumulator plus a generic ACP tool-data
mapper fix. Canonical ACP lifecycle correctness also needs shared enrichment, and Grok needs a
provider-specific patch if full, rather than explicitly truncated, tool output is a hard requirement.
The Grok assistant lifecycle/turn attribution bug should also be fixed in its adapter even if the LHC
accumulator makes capture robust to it.

## Experiment

Date: 2026-07-10. Each provider used a new empty git repository under `/tmp`, the production adapter,
the production ACP runtime/parser/state merger, and the adapter's real `ProviderRuntimeEvent` stream.
Native `session/update` payloads were captured through the adapter's native-event hook. No source file,
dogfood server, provider store, or LHC filter was modified. New instrumentation and raw results stayed
under `/tmp`.

Four paid turns were made, two per provider:

1. no-tool deterministic assistant sentinel;
2. one deterministic Python command emitting a 60 KiB `X` body between provider-specific first/last
   markers, followed by a short sentinel answer.

Cursor used `cursor-agent` 2026.07.09-c59fd9a and its advertised `default` ACP model. Grok used CLI
0.2.93 and `grok-composer-2.5-fast`. Both `initialize` and `authenticate` succeeded. The optional live
interrupt was not repeated after the `/tmp` harness hit a local Effect API error after Cursor's two
required turns; cancellation findings below are therefore code-backed, not live.

For offline intake, every normalized event was passed to the current `mapProviderRuntimeEvent` with a
real `TurnAccumulatorState`. The two exact prompts were also injected with `userPromptEvent`, matching
`CaptureService.noteTurnStarted` (`packages/lhc-host/src/capture/service.ts:463-479`). The actual
ProviderService observer runs only after `adapter.sendTurn` returns
(`apps/server/src/provider/Layers/ProviderService.ts:727-733`), so prompt/event ordering is not assumed.

## Per-provider verdict

| Fidelity point                     | Cursor                                                                                                                                                                                                                                                                                                                                                                                     | Grok                                                                                                                                                                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host-known user prompt             | **PASS if filter is widened.** Both exact prompts produced `user_prompt`; 89 and 291 UTF-8 bytes. This comes from host injection, not ACP.                                                                                                                                                                                                                                                 | **PASS if filter is widened.** Both exact prompts produced `user_prompt`; 87 and 285 UTF-8 bytes. This comes from host injection, not ACP.                                                                                                                                    |
| Assistant text                     | **FAIL in current mapper.** Raw ACP and normalized deltas were byte-identical and complete (41 chunks, 140 bytes across three segments), but completed items had no text and mapper output had zero `assistant_text` events.                                                                                                                                                               | **FAIL in current mapper.** Raw ACP and normalized deltas were byte-identical and complete (20 chunks, 45 bytes across two segments), but mapper output had zero `assistant_text` events. Completed lifecycle was additionally misattributed/missing.                         |
| Tool call name / arguments         | **PARTIAL.** Exact command survives as `arguments.command` and `arguments.rawInput.command`, but `toolName` becomes generic `command_execution`. Arguments are polluted with the complete `rawOutput`, including all 61,484 output bytes.                                                                                                                                                  | **PARTIAL.** Exact command survives as `arguments.command` and `arguments.rawInput.command`, but native `Shell`/`execute` becomes generic `command_execution`. Arguments include `content` and `rawOutput`, duplicating the preview/metadata as call arguments.               |
| Tool result status                 | **PASS.** ACP `completed` -> normalized `status:"completed"` -> `tool_result.isError:false`; mapper content also says `status=completed`.                                                                                                                                                                                                                                                  | **PASS.** ACP `completed` -> normalized `status:"completed"` -> `tool_result.isError:false`; mapper content also says `status=completed`.                                                                                                                                     |
| Full tool-result content           | **FAIL semantically at mapper.** ACP and normalized completion retain all 61,484 bytes, but `tool_result.content` is only `[tool outcome: status=completed]` (32 bytes). The full bytes survive only in the wrong LHC event, `tool_call.arguments`.                                                                                                                                        | **FAIL upstream and at mapper.** ACP reports `total_bytes:61480` and `truncated:true`, supplies only a 20,030-byte head/tail preview, and normalized state retains only that preview. Mapper then reduces it to the same 32-byte status marker.                               |
| Turn started / completed / aborted | **PARTIAL.** Two live normal turns each emitted one `turn.started` and one `turn.completed {state:"completed", stopReason:"end_turn"}`. Mapper records start only in its accumulator and emits one `turn_end` on completion. Cancellation is code-backed as `turn.completed {state:"cancelled"}`, not `turn.aborted`; mapper would emit a cancellation note plus `turn_end`.               | **PARTIAL.** Same live normal result. Code likewise represents cancellation as `turn.completed {state:"cancelled"}`, not `turn.aborted`; mapper would emit a cancellation note plus `turn_end`.                                                                               |
| Item IDs / dedupe stability        | **PASS within the live session; restart risk.** Tool ID was identical across pending/completed/raw/normalized/mapped stages, although it contained a literal newline. Assistant IDs were stable `assistant:<session>:segment:N`. Code inference: the segment counter resets to zero on runtime creation, so resuming the same ACP session can collide with historical assistant item keys. | **TOOL PASS; ASSISTANT FAIL.** Tool ID was stable through all four raw/normalized states. The first assistant segment's completion was stamped with the _second_ turn ID, and the final segment had no normalized completion. The same resume-counter collision risk applies. |

Offline mapper totals were identical in event kinds for both providers: two `user_prompt`, two
`turn_end`, one `tool_call`, one `tool_result`, and **zero** `assistant_text`. Cursor recorded three
malformed assistant completions; Grok recorded one because its other completion never reached the
normalized stream.

## Tool-output byte comparison

Counts are UTF-8 bytes. “Payload JSON” is compact `JSON.stringify` of that layer's payload, not the
output alone. The native completion payload stored under `ProviderRuntimeEvent.raw.payload` was deeply
equal to exactly one captured native `session/update` in each run.

| Provider / layer                         | Payload JSON bytes |                                                                            Tool-output bytes present at that layer | Markers / truncation                                                                                                                                                 |
| ---------------------------------------- | -----------------: | -----------------------------------------------------------------------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor raw ACP completed update          |             61,759 |                                                                                61,484 in `update.rawOutput.stdout` | first=1, last=1, `X`=61,440; no truncation metadata; SHA-256 `01f13550bc71018b4f120bb54a01aaa3ef9a4208f3d632a8c398cbf3ea405dbc`                                      |
| Cursor normalized completed tool payload |             62,146 |                                                                                  61,484 in `data.rawOutput.stdout` | Exact same complete stdout and markers.                                                                                                                              |
| Cursor mapper `tool_result.content`      |                 32 |                                                                                             0 command-output bytes | `[tool outcome: status=completed]`; neither marker.                                                                                                                  |
| Grok raw ACP completed update            |             81,578 | 20,030-byte preview in both `update.content[0].content.text` and a 20,030-element byte array at `rawOutput.output` | `total_bytes=61,480`, `truncated=true`; preview has first=1, last=1, `X`=19,960; preview SHA-256 `47ba90b25bd3893b983cf3426ec66edd0bb43e8e33f253841c964cafd36b264d`. |
| Grok normalized completed tool payload   |            101,632 |              20,030-byte preview, retained in `data.content`/`data.rawOutput` and copied into 20,029-byte `detail` | Still explicitly truncated; full 61,480 bytes are absent.                                                                                                            |
| Grok mapper `tool_result.content`        |                 32 |                                                                                             0 command-output bytes | `[tool outcome: status=completed]`; neither marker.                                                                                                                  |

Grok's preview contains both unmistakable end markers because it is a head/tail preview; marker
presence is therefore not evidence of completeness. `total_bytes` and `truncated:true` are decisive.
The 81,578-byte raw JSON size is larger than its 20,030-byte textual preview because the same preview
also appears as a JSON number array. Normalization adds another textual presentation copy, explaining
the 101,632-byte payload without adding fidelity.

## Assistant reconstruction comparison

`parseSessionUpdateEvent` accepts every non-empty ACP `agent_message_chunk` as `ContentDelta`
(`apps/server/src/provider/acp/AcpRuntimeModel.ts:508-581`). `AcpSessionRuntime` assigns all chunks in a
segment the same synthetic item ID (`apps/server/src/provider/acp/AcpSessionRuntime.ts:879-895,927-966`).
Raw ACP chunk concatenation and normalized `content.delta` concatenation were equal in every row:

| Provider / segment          | ACP + normalized deltas                                                                                            | Completed assistant lifecycle payload                                                   | Current mapper output                |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | ------------------------------------ |
| Cursor turn 1, segment 0    | 12 chunks, 29 bytes: `CURSOR_ASSISTANT_SENTINEL_7Q9`                                                               | `{itemType:"assistant_message", status:"completed"}` on the correct turn/item           | Empty; completion counted malformed. |
| Cursor tool turn, segment 1 | 20 chunks, 91 bytes: `I'll run that exact command once, wait for it to finish, then reply with only the sentinel.` | Same textless payload on the correct turn/item                                          | Empty; completion counted malformed. |
| Cursor tool turn, segment 2 | 9 chunks, 20 bytes: `CURSOR_TOOL_DONE_7Q9`                                                                         | Same textless payload on the correct turn/item                                          | Empty; completion counted malformed. |
| Grok turn 1, segment 0      | 12 chunks, 27 bytes: `GROK_ASSISTANT_SENTINEL_7Q9`                                                                 | Textless completion exists, but is incorrectly stamped with turn 2's ID                 | Empty; completion counted malformed. |
| Grok tool turn, segment 1   | 8 chunks, 18 bytes: `GROK_TOOL_DONE_7Q9`                                                                           | **No normalized completion observed**, including after a 300 ms settle and session stop | Empty.                               |

`makeAcpAssistantItemEvent` cannot carry text at all
(`apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:194-214`). The LHC mapper explicitly discards
every delta (`packages/lhc-host/src/intake/mapper.ts:85-89`) and requires text in `detail`,
`data.item.text`, or `data.text` on completion (`packages/lhc-host/src/intake/mapper.ts:128-142,327-341`).
That proves the common assistant loss without relying on inference.

There is also an ordering defect: Cursor published each normal `turn.completed` immediately before the
final assistant `item.completed`. Grok resolves notification turn IDs from mutable current adapter
state and drops events when no current turn exists (`apps/server/src/provider/Layers/GrokAdapter.ts:802-807`).
In the back-to-back run, segment 0's delayed completion inherited turn 2; after turn 2 settled,
segment 1's delayed completion was dropped. This is why merely adding text to completed payloads would
not make lifecycle-only capture reliable.

## Exact loss points

1. **Standing filter:** `CAPTURED_DRIVER_KINDS` permits only Claude and Codex, and `handleEvent` plus
   `noteTurnStarted` reject other provider kinds
   (`packages/lhc-host/src/capture/service.ts:26,442-479`). This was verified and not changed.
2. **Assistant completion is schema-poor:** `AcpParsedSessionEvent.AssistantItemCompleted` stores only
   `itemId`; `closeActiveAssistantSegment` emits only that ID; `makeAcpAssistantItemEvent` emits only
   `itemType/status` (`apps/server/src/provider/acp/AcpRuntimeModel.ts:88-95`,
   `apps/server/src/provider/acp/AcpSessionRuntime.ts:968-988`,
   `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:194-214`).
3. **Mapper discards the only complete assistant representation:** `content.delta` returns no LHC
   events, while assistant completion requires absent text fields
   (`packages/lhc-host/src/intake/mapper.ts:85-89,128-142,327-341`).
4. **Grok lifecycle attribution/drop:** the Grok consumer stamps assistant events with the current
   mutable `notificationTurnId` and drops them when that value is absent or interrupted
   (`apps/server/src/provider/Layers/GrokAdapter.ts:802-834`). Live evidence showed one cross-turn
   misattribution and one missing completion.
5. **Resume-unsafe synthetic assistant IDs (code inference):** the per-runtime segment counter starts
   at zero, and IDs are only `assistant:<ACP sessionId>:segment:<counter>`
   (`apps/server/src/provider/acp/AcpSessionRuntime.ts:258-281,927-958`). A resumed runtime for the same
   ACP session can therefore regenerate an earlier LHC item key. This was not restart-tested live.
6. **Tool state itself retains ACP data:** `makeToolCallState` stores `rawInput`, `rawOutput`, `content`,
   and locations; `mergeToolCallState` preserves earlier fields; `makeAcpToolCallEvent` copies merged
   data into the completed event (`apps/server/src/provider/acp/AcpRuntimeModel.ts:308-379,403-424`,
   `apps/server/src/provider/acp/AcpCoreRuntimeEvents.ts:160-192`). Cursor is complete here; Grok is
   already truncated by the provider-native payload.
7. **Tool mapper reads the wrong generic fields:** `outputFromToolData` checks
   `result.fullOutput`, `item.aggregatedOutput`, then `result.content/data.output/item.output`; it never
   reads ACP `data.rawOutput.stdout`, ACP `data.rawOutput.output`, or `data.content`
   (`packages/lhc-host/src/intake/mapper.ts:427-451`). It consequently emits status-only content.
8. **Tool output is misclassified as arguments:** the fallback argument builder copies almost every
   key in `data` and does not exclude `rawOutput`, `content`, `rawInput`, or locations
   (`packages/lhc-host/src/intake/mapper.ts:395-425`). Thus bytes missing from `tool_result` can be
   duplicated into `tool_call.arguments`.
9. **Cancellation is not `turn.aborted`:** Cursor maps a cancelled ACP prompt to
   `turn.completed.state="cancelled"` (`apps/server/src/provider/Layers/CursorAdapter.ts:1029-1043`);
   Grok's normal and interrupt settlement do the same
   (`apps/server/src/provider/Layers/GrokAdapter.ts:1180-1191,1274-1337`). The mapper correctly turns a
   non-`completed` completion into a runtime note plus `turn_end`
   (`packages/lhc-host/src/intake/mapper.ts:235-289`). No live interrupt was completed in this slice.

## Proposed implementation slices (not implemented)

1. **LHC ACP assistant accumulator.** Extend the per-thread mapper accumulator to retain
   `assistant_text` deltas keyed by `(threadId, turnId, itemId)`. Emit once on matching completion, or
   flush remaining segments immediately before `turn_end`. Use a turn-scoped idempotency key, not the
   resume-unsafe synthetic item ID alone. This recovers the exact live text despite late, missing, or
   misattributed completion events and preserves terminal ordering.
2. **Generic ACP tool mapping.** Teach `toolParts/outputFromToolData` to decode ACP shapes:
   `rawOutput.stdout`, textual ACP `content`, and numeric-byte `rawOutput.output`. Remove output,
   locations, and result metadata from fallback call arguments. Preserve status/exit code. When ACP
   says `truncated:true`, emit the preview plus an explicit `total_bytes`/not-captured marker; do not
   silently claim full fidelity or dereference provider-private paths in the mapper.
3. **Shared ACP lifecycle enrichment.** Accumulate segment text in `AcpSessionRuntime`, add it to
   `AssistantItemCompleted`, and let `makeAcpAssistantItemEvent` populate a mapper-supported completed
   text field. Also make assistant identity restart-safe. This improves the canonical stream for every
   consumer, but it does not replace slice 1 unless adapter ordering/turn ownership is fixed too.
4. **Grok adapter lifecycle fix.** Bind each assistant segment to its originating t3 turn and drain its
   close event before clearing that turn. Add back-to-back-turn and final-turn tests for completion
   attribution. This is provider-specific because the observed drop comes from Grok's mutable
   `resolveNotificationTurnId` path.
5. **Grok full-output decision.** If LHC requires every byte, add a narrowly scoped Grok adapter
   sidecar/full-output acquisition path with size checks and cleanup, analogous in intent to the Claude
   fidelity patch. Neither the shared parser nor the mapper can reconstruct the missing 41,450 bytes
   from this ACP payload. If provider previews are acceptable, record explicit truncation instead and
   do not call it full capture.
6. **Filter last.** Widen `CAPTURED_DRIVER_KINDS` only after slices 1-2 and fidelity tests; include
   slices 3-5 according to the desired canonical/full-output guarantee.

## Confidence and limitations

Confidence is **high** for prompt injection, assistant-text loss, normal turn semantics, Cursor full
tool-output retention through normalization, Grok native truncation, mapper output, and within-session
tool ID stability. These are backed by real authenticated turns and exact byte counts through the
production adapter/runtime/mapper path.

Confidence is **medium** for cancellation and cross-restart dedupe. Cancellation is established from
current adapter and mapper code but was not completed live. Resume collision is a direct code inference
from counter initialization and ID construction but was not exercised with a resumed session. Only one
CLI version and one model per provider were tested; provider versions may change ACP output policies.
The Grok run's first assistant completion bug was observed under back-to-back turns, and the final
completion remained absent after the stated settle/stop, but longer idle timing was not separately
tested. No fixture or raw capture was added to the repository by design.
