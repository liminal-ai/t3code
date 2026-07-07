# Codex Synthetic-Rollout Resume Probe (Slice 4.0)

Date: 2026-07-07

## Verdict

**Works.** `codex app-server` `thread/resume` accepts synthetic rollout files by
`threadId`, both in an already-running app-server process and in a fresh process. A
restart is **not required** for disk discovery: the same-process probe started
app-server, created a warm unrelated thread, wrote a brand-new synthetic rollout after
startup, resumed that new id, recalled fabricated history, and appended the new turn to
that synthetic file.

Probe: `packages/lhc-host/probes/codex-swap-probe.ts`. Evidence artifacts:
`packages/lhc-host/test/fixtures/codex-swap/`. Codex CLI: `codex-cli 0.142.5`.
Temp `CODEX_HOME`: `/var/folders/.../T/t3-codex-swap-home-zXofq3`. Temp git cwd:
`/var/folders/.../T/t3-codex-swap-cwd-P39l8F`. Paid model turns used: 6 total. One
same-process synthetic recall was repeated because the probe initially waited on the
wrong direct-notification field; both same-process attempts recalled the synthetic fact.

## Evidence Summary

**1. Baseline adapter session.** t3code's real Codex adapter created provider thread
`019f3e87-bb2f-7f32-9637-11603afb3dbf` and rollout:

```text
CODEX_HOME/sessions/2026/07/07/rollout-2026-07-07T17-41-50-019f3e87-bb2f-7f32-9637-11603afb3dbf.jsonl
```

The first `session_meta.payload.id` and `session_meta.payload.session_id` matched the
filename suffix. The adapter cursor at start and after turns was exactly:

```json
{ "threadId": "019f3e87-bb2f-7f32-9637-11603afb3dbf" }
```

Baseline used two tiny turns: remember `SILVER-HARBOR-31` + gate `4812`, then recall
`4812`. The same rollout later grew from 20 lines after baseline to 28 lines after the
sanity resume.

**2. Sanity resume through the adapter.** A new t3 thread started with
`resumeCursor: { threadId: "019f3e87-bb2f-7f32-9637-11603afb3dbf" }` recalled
`SILVER-HARBOR-31` and kept the same cursor. This proves the production adapter resume
path works before synthetic files enter the picture.

**3. Synthetic same-process.** In one already-running app-server process, the probe first
opened warm thread `019f3e8a-6746-71f3-aa7c-ae215a3f5139`, then wrote synthetic rollout
`acb7a28f-aa9b-44a4-898f-8ee364671e85`. `thread/resume` returned the synthetic id,
the recall turn answered `BRONZE-HARBOR-77`, and the file grew from 5 to 15 lines.

**4. Synthetic fresh-process.** A second synthetic rollout
`b03bc96e-2848-450d-89db-b401f4f70473` was written before app-server startup. A fresh
process resumed it, answered `COPPER-LANTERN-88`, and appended from 5 to 15 lines.

**5. Failure modes.**

- Missing file: direct `thread/resume` failed immediately with
  `CodexAppServerRequestError: no rollout found for thread id <id>`.
- First line malformed / not `session_meta`: hard reject with
  `rollout ... does not start with session metadata`.
- Later malformed line: accepted. A file with a valid first `session_meta`, bad second
  line, then valid later lines resumed with `turnCount: 1` and a valid preview. Do not
  rely on this leniency; write clean JSONL.
- Filename id vs `session_meta` id mismatch: accepted, but dangerous. Requesting
  `thread/resume` for filename id `e45b0859-a483-43f8-b954-607088a34e23` returned
  active `thread.id` `97a688d3-3b52-4698-80d2-2359545e6ca0` from `session_meta`.
  In t3code, `start()` persists `opened.thread.id`, so a mismatch would silently poison
  the cursor.

**6. Bonus `thread/fork`.** `thread/fork` from the fresh synthetic id worked without a
model turn. It created new thread `019f3e8b-1f5f-7ea3-8bc9-346ea85982c1` with
`forkedFromId: "b03bc96e-2848-450d-89db-b401f4f70473"` and preserved the synthetic
preview. This is viable as a fallback/canonicalization tool, but not needed for the
swap because direct resume works.

## Verified 4.2 Recipe

1. Stop/quiesce the live t3 Codex session before flipping. The running runtime owns the
   old provider thread id and can upsert the old cursor.
2. Mint a new id. A UUIDv4 worked in the probe; Codex's own sessions are UUIDv7-ish,
   but `thread/resume` did not require that shape.
3. Write the rebuilt rollout under:

   ```text
   <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<newId>.jsonl
   ```

   The filename timestamp uses local date/time with hyphens in the time part, matching
   codex-lhc's report and Codex's observed convention.

4. Make line 1 a valid `session_meta` envelope:

   ```json
   {
     "timestamp": "2026-07-07T21:44:45.000Z",
     "type": "session_meta",
     "payload": {
       "session_id": "<newId>",
       "id": "<newId>",
       "timestamp": "2026-07-07T21:44:45.000Z",
       "cwd": "<thread cwd>",
       "originator": "codex-lhc",
       "source": "vscode",
       "thread_source": "user",
       "model_provider": "openai",
       "cli_version": "0.142.5"
     }
   }
   ```

   Mandatory invariant: filename suffix, `payload.id`, and `payload.session_id` must all
   be identical. Copying `cli_version` and `base_instructions` from the source rollout is
   harmless and matches codex-lhc's builder, but the probe's load-bearing fields were
   identity + cwd + valid first-line metadata.

5. Emit model-visible history as `response_item` message lines and replay-visible
   history as `event_msg` lines. The minimal proven line set was copied from codex-lhc's
   `buildRolloutLines`: `session_meta`, user `response_item`, user `event_msg`,
   assistant `response_item`, assistant `event_msg`. No `turn_context`, tool records,
   sqlite writes, `history.jsonl`, or `session_index.jsonl` were required.
6. Atomically write the file if possible. The probe used direct write for speed, but
   production should use temp sibling + rename, matching codex-lhc's format report.
7. Flip t3's persisted Codex resume cursor to:

   ```json
   { "threadId": "<newId>" }
   ```

   That is the complete Codex cursor shape today. There is no Claude-style
   `{ resume, resumeSessionAt, turnCount }`.

8. Start/resume the session with the same cwd and provider instance. A restart of
   app-server is not required for discovery, but t3code's current adapter naturally
   starts a new app-server runtime per adapter session, so the production stop/start path
   will be fresh-process in practice.
9. Verify first resumed event/response. `thread/resume` should return `thread.id` equal
   to `<newId>`, and after the first turn the synthetic file should gain new
   `event_msg`, `turn_context`, and `response_item` lines.

## t3code Cursor and Persistence Shape

Codex's cursor schema is only:

```ts
{
  threadId: string;
}
```

Source anchors:

- `CodexResumeCursorSchema` is `Schema.Struct({ threadId: Schema.String })`
  (`apps/server/src/provider/Layers/CodexSessionRuntime.ts:69-71`).
- `readResumeCursorThreadId` returns that `threadId` and `openCodexThread` sends it as
  `thread/resume` `{ threadId: resumeThreadId, ...startParams }`
  (`CodexSessionRuntime.ts:259-265`, `459-467`).
- `start()` rewrites the session cursor to `{ threadId: opened.thread.id }`
  (`CodexSessionRuntime.ts:1207-1224`).
- `makeCodexAdapter` passes only a cursor that satisfies this schema
  (`apps/server/src/provider/Layers/CodexAdapter.ts:1390-1399`).
- Server persistence stores this unknown JSON as `resume_cursor_json`
  (`apps/server/src/persistence/ProviderSessionRuntime.ts:48`, `103-106`, `171`,
  `200`).

Exact Slice 4.2 persisted binding flip:

```json
{
  "threadId": "<t3 thread id>",
  "providerName": "codex",
  "providerInstanceId": "<same instance id>",
  "adapterKey": "codex",
  "runtimeMode": "<preserve existing>",
  "resumeCursor": { "threadId": "<rebuiltCodexSessionId>" }
}
```

Only `resumeCursor.threadId` is load-bearing for Codex resume. Preserve provider
instance, cwd/runtime metadata, and status as normal server bookkeeping.

## Traps and Mandatory Invariants

- **Adapter missing-id fallback is silent enough to be dangerous.** Direct app-server
  returns `no rollout found for thread id <id>`, but t3code's `openCodexThread` treats
  messages containing `not found` as recoverable and falls back to `thread/start`
  (`CodexSessionRuntime.ts:57-63`, `468-474`). Slice 4.2 must prevalidate the rollout
  path before writing the cursor and must verify the resumed `thread.id` after start.
  Otherwise a bad cursor can create a fresh Codex thread instead of failing loudly.
- **ID mismatch poisons the cursor.** If filename and first `session_meta` disagree,
  app-server may find the file by filename but return the metadata id as `thread.id`.
  Since t3code persists `opened.thread.id`, this can replace the intended cursor with
  an id that may not match any filename on a later process.
- **First line must be `session_meta`.** Missing or malformed first-line metadata hard
  rejects. Later malformed JSONL lines were skipped/tolerated in this probe, but a
  rebuilder should still write fully valid JSONL.
- **`ProviderSessionDirectory.upsert` preserves the old cursor when
  `binding.resumeCursor` is omitted** (`ProviderSessionDirectory.ts:139-142`). The flip
  must actively include `resumeCursor`; a status-only upsert will not swap anything.
- **Stop live sessions before writing/flipping.** A live runtime can continue appending
  the old rollout and can upsert the old cursor after the swap.
- **No `session_index.jsonl` or sqlite prewrite required.** The temp home had no
  prewritten `session_index.jsonl`; app-server created/updated its own sqlite catalog
  as a side effect of resume. Treat index/sqlite as listing/cache, not resume input.
- **Cwd matters.** The probe resumed with the same cwd as `session_meta.payload.cwd`.
  Keep the rebuilt `cwd` equal to the t3 thread cwd unless intentionally migrating.

## codex-lhc Reuse

This probe reused codex-lhc's format research and minimal builder shape:

- `docs/codex-rollout-format-report.md` says current rollouts are JSONL envelopes
  `{ timestamp, type, payload }`; file ids should match first `session_meta.payload.id`
  and `session_id`; default placement is `sessions/YYYY/MM/DD/rollout-...-<id>.jsonl`;
  sqlite is a catalog/cache; and the robust synthetic recipe is file + first
  `session_meta` + model-visible `response_item` messages + replay `event_msg`s.
- `src/rollout/rebuild.ts` emits exactly the three line types proven here:
  `session_meta`, `response_item`, and `event_msg`, with user content as
  `{ type: "input_text" }` and assistant content as `{ type: "output_text" }`.

The probe deliberately did not port codex-lhc's whole writer; it used the line shape
only, proving `thread/resume` itself does not require `session_index.jsonl`,
`turn_context`, or external sqlite manipulation.

## Commands

```sh
node packages/lhc-host/probes/codex-swap-probe.ts
```

The probe is resumable via `packages/lhc-host/test/fixtures/codex-swap/state.json`; later
runs skip completed paid phases and can rerun non-paid failure probes.

## Deviations

- The same-process diagnostic used the generated `effect-codex-app-server` client
  directly because the public adapter API spawns/closes app-server per runtime and does
  not expose a way to ask one running process to resume another arbitrary id. Baseline
  and sanity resume used the real t3code Codex adapter.
- The temp `CODEX_HOME` copied auth/config files from `~/.codex` so paid calls could
  authenticate, but all sessions, sqlite, and rollout writes landed in the temp home.
- One same-process recall was repeated after a probe waiter bug; the bug was in the
  harness's direct notification bookkeeping, not in Codex. The first direct log already
  showed `BRONZE-HARBOR-77` and append success; the second run is what `state.json`
  records.
