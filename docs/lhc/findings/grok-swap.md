# Grok Synthetic-Session Resume Probe (Phase C, Grok leg)

Date: 2026-07-09

## VERDICT

**REBUILD.** Grok's `session/load` (ACP `grok agent stdio`) resolves a session by a
**local on-disk directory**, and the conversation stored there is authoritative for the
model's context. A fully synthetic session directory — new id the server has never seen,
fabricated `chat_history.jsonl` — is accepted by `session/load` and the model recalls the
fabricated fact on the next turn. Editing an assistant string in a scratch copy surfaced
the edit in the resumed model context (`ACK-CONTEXT-MUTATED-93`, not the original). Local
files are not a cache; they are the source. Server-side threads/validation play no part in
the resume path.

Probe: `packages/lhc-host/probes/grok-swap-probe.ts` (phases `init` → `baseline` →
`sanity` → `mutation` → `synthetic-fresh-process` → `synthetic-same-process` →
`failures`). Evidence: `packages/lhc-host/test/fixtures/grok-swap/` (`state.json`,
per-phase `*-protocol.jsonl` ACP transcripts, `failure-outcomes.json`, and pre/post-load
session snapshots). Grok CLI: `grok 0.2.93 (f00f96316d4b)`. Scratch `GROK_HOME`:
`/var/folders/.../T/t3-grok-swap-home-5g5ZY5`; scratch git cwd:
`/var/folders/.../T/t3-grok-swap-cwd-zblTEl`. Model: `grok-composer-2.5-fast`.
**Paid model turns: 5** (budget 15): baseline seed, sanity recall, mutation recall,
synthetic-fresh recall, synthetic-same recall. All five recalled the intended fact on the
first attempt; no iteration on file shape was required.

## Most surprising finding

**`chat_history.jsonl` and `updates.jsonl` are two independent stores that can disagree,
and the model follows `chat_history.jsonl`.** In the mutation phase I edited only
`chat_history.jsonl` (the assistant marker) and left `updates.jsonl` untouched. On resume,
the ACP **replay** stream (`session/update` notifications the client renders) still showed
the _original_ strings from `updates.jsonl` (`ACK-ORIGINAL-77`, `SAPPHIRE-KESTREL-41`),
while the **model** answered from the _edited_ `chat_history.jsonl`
(`ACK-CONTEXT-MUTATED-93`). So the replay you see on load is not necessarily what the model
was given. A rebuild that only rewrites replay (`updates.jsonl`) would look right in the UI
and silently feed the model stale context, and vice-versa. Rewrite **both**, and treat
`chat_history.jsonl` as the model-context source of truth.

## Storage format

Sessions are **directories**, not single files:

```text
$GROK_HOME/sessions/<url-encoded-cwd>/<sessionId>/
```

- `<url-encoded-cwd>` is `encodeURIComponent(cwd)` of the session's working directory
  (`/private/tmp` → `%2Fprivate%2Ftmp`). `session/load` passes `cwd`; the loader looks
  under `sessions/encodeURIComponent(cwd)/<sessionId>/`. A `cwd` that doesn't match the
  directory the session lives under → `FS_NOT_FOUND` (see failure modes). Keep the rebuilt
  session's directory encoding equal to the `cwd` you will pass on load.
- `<sessionId>` is the directory name and the load key. Grok's own ids are UUIDv7-ish
  (`019f4967-98f2-7783-…`), but **a UUIDv4 works** — every synthetic/mutation phase used
  `crypto.randomUUID()` (v4) ids and loaded fine. No id-shape validation.

Files in a real session directory (observed):

| File                                                                                               | Role                                                              | Required for `session/load`?                                |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `summary.json`                                                                                     | session metadata (`info.id`, `info.cwd`, model, counts)           | **YES** — absence → `FS_NOT_FOUND` reject                   |
| `chat_history.jsonl`                                                                               | **model-visible** conversation (authoritative context)            | No to _load_, but required for the model to recall anything |
| `updates.jsonl`                                                                                    | ACP `session/update` **replay** stream (client UI reconstruction) | No — absent → load succeeds with empty replay               |
| `system_prompt.txt`                                                                                | system prompt text                                                | No (mirror of chat line 0)                                  |
| `events.jsonl`, `prompt_context.json`, `signals.json`, `rewind_points.jsonl`, `hunk_records.jsonl` | telemetry / UI / edit-tracking                                    | No                                                          |

`session_search.sqlite` (+ `-wal`/`-shm`) lives at `sessions/session_search.sqlite`, one
level **above** the per-cwd dirs. It is a **search catalog, not a load input**: the scratch
home began with no sqlite, synthetic sessions loaded before they could have been indexed,
and the missing-session error is a filesystem stat (`FS_NOT_FOUND` /
`No such file or directory (os error 2)`), not a DB miss. Grok creates/updates the sqlite
as a side effect of running; a rebuild does not need to write it.

### `chat_history.jsonl` line shape (proven-sufficient minimal set)

One JSON object per line. The synthetic rebuild used exactly three line types and the model
ingested the history:

```jsonc
{"type":"system","content":"<system prompt string>"}
{"type":"user","content":[{"type":"text","text":"<user_query>...</user_query>"}]}
{"type":"assistant","content":"<assistant text>","model_id":"grok-composer-2.5-fast","model_fingerprint":"synthetic"}
```

- `user.content` is an **array of content blocks** (`[{type:"text",text}]`); `assistant.content`
  is a **plain string**. `system.content` is a plain string.
- **`reasoning` lines are NOT required.** Real grok turns write a
  `{"type":"reasoning","id","summary","encrypted_content","status"}` line whose
  `encrypted_content` is a server-sealed blob. Synthetic sessions omitted reasoning
  entirely and worked; grok minted its own valid `encrypted_content` for the _new_ turn it
  generated on top. So a rebuild can skip reasoning/thinking lines (as the Claude and Codex
  rebuilds skip thinking) — you do **not** need to fabricate `encrypted_content`.
- `model_fingerprint` value is not validated (`"synthetic"` accepted).

### `updates.jsonl` line shape (for faithful replay, optional for load)

Each line is `{timestamp, method, params}`. Real grok emits, per turn:

```jsonc
{"method":"session/update","params":{"sessionId","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":...}}}}
{"method":"session/update","params":{"sessionId","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":...}}}}
{"method":"session/update","params":{"sessionId","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":...}}}}
{"method":"_x.ai/session/update","params":{"sessionId","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}}}
```

The synthetic rebuild wrote `user_message_chunk` + `agent_message_chunk` + the
`_x.ai/session/update turn_completed` line (no thought chunk) and replay rendered correctly.
Only write this if you want the resumed session's scrollback to look right; it does not feed
the model.

## Verified recipe

1. **Stop/quiesce the live t3 Grok session** before touching files (the running ACP child
   owns the directory and will keep appending / can re-upsert the old cursor).
2. **Mint a new id.** UUIDv4 is accepted.
3. **Create the directory** `"$GROK_HOME"/sessions/encodeURIComponent(cwd)/<newId>/`.
4. **Write `summary.json`** (mandatory). Minimal proven shape:

   ```json
   {
     "info": { "id": "<newId>", "cwd": "<session cwd>" },
     "session_summary": "…",
     "created_at": "<iso>",
     "updated_at": "<iso>",
     "num_messages": 2,
     "num_chat_messages": 3,
     "current_model_id": "grok-composer-2.5-fast",
     "next_trace_turn": 1,
     "chat_format_version": 1,
     "grok_home": "<GROK_HOME>",
     "agent_name": "cursor"
   }
   ```

   `info.id` need **not** match the directory name (mismatch accepted — see failure modes),
   but keep them equal for sanity.

5. **Write `chat_history.jsonl`** with the model-visible history (system + user/assistant
   lines above). This is what the resumed model sees.
6. **Write `updates.jsonl`** mirroring the same exchange as replay chunks (optional; for UI
   fidelity only).
7. **`session/load`** with `{ sessionId: <newId>, cwd: <same cwd>, mcpServers: [] }` after
   `initialize` + `authenticate`. Grok replays `updates.jsonl` as `session/update`
   notifications, then responds. (t3code races the load RPC against a replay-idle gap —
   `AcpSessionRuntime.startOnce`, the `sessionLoadGateRef` / `waitForSessionLoadReplayIdle`
   path; the probe just awaited the RPC + a 1.5s drain.)
8. **Verify** with a real recall turn. The synthetic phases confirmed
   `session/prompt` after load recalls the fabricated fact and appends the new
   user/reasoning/assistant lines to the synthetic `chat_history.jsonl` in place.

Same-process vs fresh-process: **no restart required.** `synthetic-same-process` wrote a
brand-new session directory _after_ the ACP child was already initialized and `session/load`
picked it up immediately (grok stats the directory at load time). `synthetic-fresh-process`
wrote the directory before spawning. Both recalled their fabricated codename. In practice
t3code spawns a fresh `grok agent stdio` per adapter session anyway, so the production
stop→write→start path is fresh-process.

## Failure modes (`failures` phase, `failure-outcomes.json`)

| Case                                              | Outcome                                                                                                                                                                                                   |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unknown/absent session id** (dir doesn't exist) | **Hard reject** at `session/load`: `-32603 "Path not found." {code:"FS_NOT_FOUND", detail:"No such file or directory (os error 2)"}`. Loud and immediate — unlike Claude's silent fresh-session fallback. |
| **Malformed id** (`"not-a-uuid"`)                 | Same `FS_NOT_FOUND` reject (treated as a dir name that doesn't exist; no shape check).                                                                                                                    |
| **Missing `summary.json`**                        | **Hard reject** `FS_NOT_FOUND`. `summary.json` is load-bearing.                                                                                                                                           |
| **Missing `updates.jsonl`**                       | **Accepted**; load succeeds with empty replay. (Model context still comes from `chat_history.jsonl`.)                                                                                                     |
| **Missing `chat_history.jsonl`**                  | **Accepted**; replay came from `updates.jsonl`. Load tolerates it, but the model would have no chat context — write it.                                                                                   |
| **Dir id ≠ `summary.json` `info.id`**             | **Accepted**; replay rendered. Load is keyed by directory name, not by the id inside `summary.json`. Dangerous if a downstream reader trusts `info.id` — keep them equal.                                 |

Net: `session/load` requires the directory + `summary.json` to exist and rejects loudly
(`FS_NOT_FOUND`) when they don't. There is **no silent fresh-session fallback at the ACP
layer** for a missing id (contrast Claude). Note t3code's own `parseGrokResume`
(`GrokAdapter.ts:175-180`) silently drops a cursor whose `schemaVersion !== 1` or whose
`sessionId` is blank and starts a fresh session — so validate the cursor shape before the
flip, then rely on the loud `FS_NOT_FOUND` for a well-formed-but-missing id.

## t3code cursor / persistence shape (server-level scope note)

Grok's resume cursor schema (adapter):

```json
{ "schemaVersion": 1, "sessionId": "<grok session id>" }
```

- `parseGrokResume` requires `schemaVersion === 1` and a non-empty `sessionId`, returning
  `{ sessionId }`; anything else → `undefined` → **fresh session, silently**
  (`GrokAdapter.ts:175-180`, `565`).
- `startSession` builds the runtime with `resumeSessionId` → ACP `session/load`
  (`GrokAdapter.ts:565`, `578`; `AcpSessionRuntime.startOnce` `options.resumeSessionId`
  branch, `AcpSessionRuntime.ts:547-620`), and writes the post-start cursor as
  `{ schemaVersion: 1, sessionId: started.sessionId }` (`GrokAdapter.ts:757-759`).
- Server persistence is the shared `resume_cursor_json` JSON column
  (`apps/server/src/persistence/ProviderSessionRuntime.ts:48`, `105`, `160-182`,
  `200-220`) — same mechanism as Claude/Codex.
- **Upsert gotcha (identical to the Claude/Codex probes):**
  `ProviderSessionDirectory.upsert` preserves the existing persisted cursor whenever
  `binding.resumeCursor` is omitted
  (`ProviderSessionDirectory.ts:139-142`). The flip must actively write
  `resumeCursor: { schemaVersion: 1, sessionId: <rebuiltId> }`; a status-only upsert won't
  swap it, and any live-session upsert carrying the old cursor that lands after the flip
  will undo it. Stop the live session first, then flip.

Exact Slice-equivalent binding flip:

```json
{
  "threadId": "<t3 thread id>",
  "providerName": "grok",
  "providerInstanceId": "<same instance id>",
  "adapterKey": "grok",
  "runtimeMode": "<preserve existing>",
  "resumeCursor": { "schemaVersion": 1, "sessionId": "<rebuiltGrokSessionId>" }
}
```

Only `resumeCursor.sessionId` (with `schemaVersion: 1`) is load-bearing for resume.

## Auth / isolation notes

- **`GROK_HOME` env var isolates the whole store** (verified: strings in the binary; the
  scratch home held all sessions/sqlite while the real `~/.grok` was never written). There
  are also `GROK_AUTH_PATH` / `GROK_AUTH` overrides. The probe set `GROK_HOME=<scratch>` and
  copied only `auth.json`, `config.toml`, `.metadata_version`, `agent_id`,
  `models_cache.json`, `version.json`, `active_sessions.json` out of the real home — never
  session data.
- Auth: no `XAI_API_KEY` present → t3code uses ACP auth method `cached_token`
  (`GrokAcpSupport.ts:47-51`); the copied `auth.json` OIDC token (valid, with refresh token)
  authenticated every paid call. Spawn is `grok agent stdio` with
  `GROK_OAUTH2_REFERRER=t3code` (`GrokAcpSupport.buildGrokAcpSpawnInput`).
- ACP wire is **newline-delimited JSON-RPC** (`RpcSerialization.ndJsonRpc()`,
  `packages/effect-acp/src/protocol.ts:78`); the probe speaks it directly rather than
  through the effect-acp client, so it can drive `session/load` against arbitrary
  hand-authored stores.

## Commands

```sh
node packages/lhc-host/probes/grok-swap-probe.ts init      # scratch home + cwd, 0 paid
node packages/lhc-host/probes/grok-swap-probe.ts baseline  # 1 paid: seed a real session
node packages/lhc-host/probes/grok-swap-probe.ts sanity    # 1 paid: resume + recall (fresh proc)
node packages/lhc-host/probes/grok-swap-probe.ts mutation  # 1 paid: edit chat_history, recall edit
node packages/lhc-host/probes/grok-swap-probe.ts synthetic-fresh-process   # 1 paid
node packages/lhc-host/probes/grok-swap-probe.ts synthetic-same-process    # 1 paid
node packages/lhc-host/probes/grok-swap-probe.ts failures  # 0 paid: load failure matrix
```

Resumable via `packages/lhc-host/test/fixtures/grok-swap/state.json` (baseline session id +
scratch paths persist; later phases reuse them).

## Deviations

- The probe speaks raw ndjson ACP to `grok agent stdio` directly (not via the t3code Grok
  adapter). The task explicitly permitted spawning the agent yourself; direct ACP gives the
  control needed to load hand-authored stores. The adapter's own resume path
  (`GrokAdapter.startSession` → `resumeSessionId` → `session/load`) is unchanged and the
  cursor mapping above ties the mechanism back to it.
- A prior probe run (same session lineage) had already completed `init` + `baseline`; this
  run continued from that `state.json`, so only 4 additional paid turns were spent here (5
  total across the probe's life).
- The real `~/.grok` was never modified. `session_search.sqlite` did get created inside the
  **scratch** home by grok itself during runs — expected, and evidence it's a side-effect
  catalog rather than a load input.

```

```
