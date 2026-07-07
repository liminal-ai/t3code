# Claude Session-Swap Recipe Probe (Slice 0.3)

Date: 2026-07-07

## Verdict

**Works.** A t3code-managed Claude session can be swapped onto a rebuilt rollout file by
starting a new adapter session with `resumeCursor: { resume: <rebuiltSessionId> }`. The
resumed session recalled only the rebuilt file's content (`BRONZE-HERON-77`, not the
original `AZURE-FALCON-42`), appended its new turn to the rebuilt file in place, and kept
the rebuilt session id. No `sessions-index.json` entry was needed. A resume against a
nonexistent session id is loudly detectable: `startSession` succeeds, but the first turn
completes with `state: "failed"` and `errorMessage: "No conversation found with session
ID: <uuid>"`.

Probe: `packages/lhc-host/probes/claude-swap-probe.ts` (phases `baseline` → `rebuild` →
`swap` → `missing`). Evidence artifacts:
`packages/lhc-host/test/fixtures/claude-swap/`. 3 provider sessions used (budget 5), model
`claude-haiku-4-5-20251001`, fresh temp git repo as cwd.

## The verified recipe

1. **Know the source session's rollout.** A live adapter session's cursor is on
   `ProviderSession.resumeCursor`; after a turn it looks like
   `{ threadId, resume: "04df30f8-…", resumeSessionAt: "6684286f-…", turnCount: 1 }`
   (`updateResumeCursor`, `apps/server/src/provider/Layers/ClaudeAdapter.ts:1447-1465`).
   `resume` IS the Claude session id; the rollout lives at
   `~/.claude/projects/<encoded-cwd>/<resume>.jsonl`. The cwd encoding replaces every
   char outside `[A-Za-z0-9-]` with `-`, applied to the **realpath** (our
   `/var/folders/...` tmp dir encoded as `-private-var-folders-...`). The probe's
   `findRolloutPath` (claude-swap-probe.ts:105-113) falls back to scanning
   `~/.claude/projects/*/<sessionId>.jsonl`, which is the robust approach.
2. **Stop the live session first.** The rollout is append-owned by the running CLI; the
   probe called `adapter.stopSession` before touching files.
3. **Mint a new session uuid** and write the rebuilt rollout to
   `~/.claude/projects/<same-encoded-cwd>/<newSessionId>.jsonl`.
4. **Rebuilt line shape** (minimal, proven sufficient — claude-swap-probe.ts:283-330,
   modeled on cc-lhc's rebuild-core `buildRolloutLines` in `rollout/rebuild.ts` — the
   line shape only, not the full `writeRebuiltRollout` pipeline): one JSONL object per
   message, a fresh uuid
   chain rooted at `parentUuid: null`, every line carrying:
   - `type`: `"user"` | `"assistant"`
   - `uuid`: fresh uuid; `parentUuid`: previous line's uuid (or `null` for the first)
   - `sessionId`: the NEW session uuid (must match the filename)
   - `isSidechain: false`, `cwd` (the realpath cwd), `timestamp` (ISO)
   - envelope scalars copied from the source rollout: `version`, `gitBranch`,
     `userType`, `entrypoint`
   - user `message`: `{ role: "user", content: "<text>" }` (plain string content works,
     even though the live CLI writes content-block arrays)
   - assistant `message`: `{ role: "assistant", id: "msg_<uuid-no-dashes>", type:
"message", model: "<model>", stop_reason: "end_turn", content: [{ type: "text",
text }] }`
     Not required: `requestId`, `promptId`, `promptSource`, `permissionMode`, `usage`,
     `diagnostics`, `queue-operation`/`attachment`/`last-prompt`/`ai-title` metadata lines,
     thinking blocks. Wholly synthetic exchanges (never sent to the provider) are honored —
     the rebuilt file's fabricated "Confirm the deployment codename" exchange was treated
     as real history.
5. **Swap.** Start a new adapter session with the SAME `cwd` and
   `resumeCursor: { resume: <newSessionId> }`. `readClaudeResumeState`
   (`ClaudeAdapter.ts:562-598`) accepts `{ resume }` (or legacy `sessionId`) and requires
   it to be a well-formed uuid — a non-uuid is silently dropped and you get a FRESH
   session, so validate before calling. `startSession` passes it straight to the SDK as
   `queryOptions.resume` (`ClaudeAdapter.ts:3461`); no `sessionId` option is set in that
   case (`ClaudeAdapter.ts:3094-3095`).
6. **Verify.** First turn's `thread.started` event reports
   `payload.providerThreadId === <newSessionId>` — the SDK did NOT fork a new session id;
   it adopted the rebuilt one and the post-turn cursor was
   `{ resume: c3d7ea24-…, resumeSessionAt: <new assistant uuid>, turnCount: 1 }`.

### Swap-run evidence

- Recall answer: `BRONZE-HERON-77` exactly (`swap-normalized.jsonl`, the
  `item.completed` assistant_message; verdict recorded in `state.json → swap`).
- The resumed model's thinking said "Earlier in the conversation…", confirming the
  rebuilt lines were ingested as prior context
  (`rebuilt-rollout-post-swap.jsonl` line 11).
- File append: rebuilt rollout grew from 4 lines to 14 during the swap turn — the CLI
  appended `queue-operation`×2, the new `user` line, `attachment`×3, assistant thinking +
  text lines, `last-prompt`, and `mode`, all with `sessionId: <newSessionId>`
  (`rebuilt-rollout-post-swap.jsonl` lines 5-14). The original baseline rollout was left
  untouched.

## Sessions-index answer

**Not needed.** The probe never wrote a sessions-index entry; in fact no
`sessions-index.json` existed anywhere in the probe's project dir and resume still
worked. Provenance note: cc-lhc's full writer, `writeRebuiltRollout`
(`rollout/write-rebuilt.ts:86-97`), always follows the rollout write with
`appendSessionsIndexEntry` — this probe deliberately used only the rebuild-core line
shape (`buildRolloutLines`) WITHOUT the index append, proving the index is not part of
the resume path. The index (shape in cc-lhc `rollout/sessions-index.ts`) is a UI/listing
concern (`claude --resume` picker, first-prompt/summary display). The later rebuilder
port can skip the index-append code for the swap mechanism itself; port it only if we
care about the session showing up correctly in Claude Code's own resume picker.

## Failure mode: resume uuid with no rollout file

Observed with `resumeCursor: { resume: <random uuid> }` (`missing-normalized.jsonl`,
`state.json → missing`):

- `startSession` **succeeds** (status `ready`, cursor echoes the ghost uuid). Resume is
  lazy — nothing validates the file at session start.
- The first `sendTurn` is accepted, then the turn terminates as `turn.completed` with
  `payload.state: "failed"` and
  `payload.errorMessage: "No conversation found with session ID: <uuid>"`, zero cost and
  zero tokens.
- Two `runtime.error` events follow (`class: "provider_error"`): the same "No
  conversation found…" message, then "Claude runtime stream failed."
  (`ProviderAdapterProcessError`). The session is torn down — `listSessions` no longer
  returns the thread.
- **No silent fresh session** and no ghost rollout file was created.

So swap failure IS detectable at the integration point, but only at first-turn time, not
at `startSession` time. The integration should both pre-validate that the rebuilt
rollout file exists (cheap) and treat a first-turn `state: "failed"` with the
"No conversation found" errorMessage as a swap failure signal — prevalidation alone has
a check-to-first-turn gap (see "Prevalidation limits" in the scope note). Caveat: a **malformed**
`resume` value (non-uuid) fails differently — `readClaudeResumeState` drops it and starts
a fresh session silently. Validate uuid shape before handing the cursor to the adapter.

## Scope note: adapter level vs. server level

This probe proves the mechanism at ADAPTER level (`makeClaudeAdapter` driven directly).
The real implementation must integrate at server level:

- **Exact persisted cursor.** The server persists `resumeCursor` as `resume_cursor_json`
  in `apps/server/src/persistence/ProviderSessionRuntime.ts` (JSON-string column, decode
  at ~line 105; write ~line 160-182, read ~line 200-220). The authoritative adapter shape
  is what `updateResumeCursor` writes (`ClaudeAdapter.ts:1453-1458`):
  `{ threadId, resume?, resumeSessionAt?, turnCount }`. The flip must write exactly:

  ```json
  { "threadId": "<t3 thread id>", "resume": "<rebuiltSessionId>", "turnCount": <carried-over turn count> }
  ```

  Only `resume` is load-bearing: `readClaudeResumeState` → `queryOptions.resume`
  (`ClaudeAdapter.ts:3093`, `3461`). `threadId` and `turnCount` are metadata — the
  cursor's `threadId` is only span-annotated (`3489`) and `turnCount` is only echoed into
  the new session's cursor (`3536`, defaults to 0) — so carry them for shape fidelity,
  but a bare `{ "resume": "<rebuiltSessionId>" }` is what this probe verified working.

- **`resumeSessionAt`: cleared on flip** (omit the field), not repointed at the rebuilt
  leaf assistant uuid. Rationale: the adapter never passes `resumeSessionAt` to the SDK —
  `queryOptions` carry only `resume`/`sessionId` (`ClaudeAdapter.ts:3461-3462`) — so a
  stale value cannot break resume; it is only echoed into the new cursor (`3535`) and
  seeds `context.lastAssistantUuid` (`3560`), leaving metadata pointing at an assistant
  uuid that does not exist in the rebuilt file until the first assistant message
  overwrites it (`2542` → `1456`). Omitting it avoids that stale window and is the
  configuration this probe verified end-to-end (the swap cursor had no `resumeSessionAt`
  and regained a correct one after turn 1). Repointing at the rebuilt leaf assistant uuid
  would likely also work but is unverified.
- **Upsert gotcha: the flip must actively write the new cursor.**
  `ProviderSessionDirectory.upsert` preserves the EXISTING persisted cursor whenever the
  `resumeCursor` field is omitted from the binding
  (`apps/server/src/provider/Layers/ProviderSessionDirectory.ts:139-142`:
  `binding.resumeCursor !== undefined ? binding.resumeCursor : existingRuntime?.resumeCursor`).
  An upsert that merely touches status/lastSeenAt will NOT flip the cursor — and,
  conversely, any adapter-driven upsert carrying the OLD session's cursor that lands
  after the flip will silently undo it. Order of operations: stop/quiesce the live
  session first, confirm no in-flight cursor writes remain, THEN write the flipped
  cursor.
- **Live sessions must be stopped before the flip** — the running CLI owns the old
  rollout and the in-memory context would keep reporting the old session id.
- **`ProviderSessionReaper`** (`apps/server/src/provider/Services/ProviderSessionReaper.ts`,
  impl in `provider/Layers/ProviderSessionReaper.ts`) manages session lifecycle at server
  level. Not chased here — Slice 2.2 checklist:
  - a reaped-then-revived session picks up the flipped cursor, not a cached one;
  - the reaper cannot race a swap in progress (reaping mid-flip, or reviving the old
    session while the rebuilt file is being written);
  - a live/reviving session writing its own cursor upsert around the flip (the undo
    hazard above).
- **Prevalidation limits.** Validating uuid shape + rebuilt-rollout file existence before
  the flip covers the failure modes observed in this probe, but NOT:
  (a) the rollout file being deleted between the check and the first turn — the ghost-uuid
  failure signature ("No conversation found with session ID") would then surface at
  first-turn time despite a passing precheck; and
  (b) the reaper/live-session races above. Both are Slice 2.2 checklist items, not solved
  problems.

## Commands

```sh
node packages/lhc-host/probes/claude-swap-probe.ts --phase baseline
node packages/lhc-host/probes/claude-swap-probe.ts --phase rebuild    # no provider session
node packages/lhc-host/probes/claude-swap-probe.ts --phase swap
node packages/lhc-host/probes/claude-swap-probe.ts --phase missing
```

## Deviations

- None material. All three provider-session phases succeeded on the first attempt; no
  iteration on the rebuilt line shape was required beyond starting from the cc-lhc
  rebuild-core line shape (`buildRolloutLines`).
- The temp cwd had to be treated by realpath (`/private/var/...`) for the encoded
  projects dir; the probe sidesteps encoding subtleties by scanning for
  `<sessionId>.jsonl`.
- As in slice 0.2, the SDK query runtime lingers after `stopSession`; the probe calls
  `process.exit(0)` after flushing output.
