# Cursor Synthetic-Session Resume Probe (Phase C, Cursor leg)

Date: 2026-07-09

## VERDICT

**REBUILD.** Cursor's local ACP session store is authoritative for `session/load`, and
synthetic local sessions — both a byte-mutated copy and a wholly hand-authored one — are
accepted and ingested by the model as real prior context. Same `session/load` path, three
different local contents, three different recalled codenames:

| Session                          | Store origin                                 | Model recalled     |
| -------------------------------- | -------------------------------------------- | ------------------ |
| `c51a13cf-…` (baseline)          | real, seeded by cursor-agent                 | `EMBER-ORCHID-314` |
| `732bf83f-…` (byte-mutated copy) | fabricated (equal-length codename swap)      | `QUARTZ-MANTIS-42` |
| `1d2c3104-…` (hand-authored)     | fabricated (protobuf DAG built from scratch) | `SABLE-COMET-663`  |

The mutated/synthetic codenames were never produced by any model, so their recall proves
the local store is authoritative (not cloud-backed / not signature-validated for the
plaintext conversation). REBUILD is the correct strategy — no RESEED fallback needed.

Probe: `packages/lhc-host/probes/cursor-swap-probe.ts` (phases `baseline` → `sanity` →
`mutate` → `swap-mutate` → `rebuild` → `swap-synth` → `missing`). ACP load/recall helper:
`packages/lhc-host/probes/cursor-load-inspect.ts`. Verified from-scratch builder (Python
reference used during the probe): `test/fixtures/cursor-swap/build-synth.py`. Evidence:
`packages/lhc-host/test/fixtures/cursor-swap/` (store snapshots, replay dumps,
`results.json`). Paid turns: **4** (`baseline`, `sanity`, `swap-mutate`, `swap-synth`; a
5th attempt with model id `composer-2.5-fast` was rejected by `set_config_option` before
any model call, so cost 0). Model `composer-2.5`. `cursor-agent` `2026.07.09-c59fd9a`,
logged in as `lee.g.moore@gmail.com`.

## Most surprising thing

Cursor does **not** store sessions as JSONL transcripts (the known-recon assumption). Each
session is a **content-addressed Merkle DAG in SQLite**: `blobs(id TEXT PRIMARY KEY, data
BLOB)` where **`id == sha256(data)` for every blob** (verified for all 11 baseline blobs),
plus a one-row `meta` table pointing at the DAG root. Messages are JSON blobs; the tree/
conversation/root nodes are protobuf blobs that reference children by their raw 32-byte
SHA-256. So "editing history" means a content-addressed graph rewrite, not a line edit.

## On-disk format

Per session at `~/.cursor/acp-sessions/<sessionId>/`:

- `store.db` — SQLite, two tables:
  - `blobs (id TEXT PRIMARY KEY, data BLOB)` — `id = sha256(data)`, content-addressed.
  - `meta (key TEXT PRIMARY KEY, value TEXT)` — single row, `key='0'`, `value` is
    **hex-encoded JSON**: `{ agentId, latestRootBlobId, name, mode, isRunEverything,
createdAt }`. `latestRootBlobId` is the DAG root blob id.
- `meta.json` — `{ "schemaVersion": 1, "cwd": "<abs path>", "title": "<name>" }`.
- `store.db-wal`, `store.db-shm` — SQLite WAL. Delete these before/after direct writes so
  your writes are the authoritative committed state (the probe writes with a fresh DB and
  no lingering WAL).

The dir name is the **sessionId only** — not cwd-hashed. `session/load` keys purely on
sessionId; loading a session from a _different_ cwd still succeeds and replays its content
(verified free). Keep the rebuilt `cwd` fields consistent with the t3 thread cwd anyway
(they surface in the model's `<user_info>` context), but cwd does not gate discovery.

### Blob roles (baseline session)

JSON message blobs (plain UTF-8, first byte `{`):

- **system_prompt** — `{"role":"system","content":"You are an AI coding assistant, powered
by Composer…"}`.
- **user_info** — `{"role":"user","content":"<user_info>OS Version…Workspace Path…"}` (the
  environment/context block; ~44 KB).
- **user query** — `{"role":"user","content":[{"type":"text","text":"<timestamp>…
</timestamp>\n<user_query>\n…\n</user_query>"}],"providerOptions":{"cursor":{"requestId":
"<uuid>"}}}`.
- **assistant** — `{"role":"assistant","content":[{"type":"redacted-reasoning","data":
"<opaque signed token>","providerOptions":{"cursor":{"modelName":"composer-2.5"}}},
{"type":"text","text":"ACK EMBER-ORCHID-314"}],"id":"1"}`.

Protobuf DAG blobs (binary; children referenced as raw 32-byte sha256):

- **context node** — repeated f1 refs `[system_prompt, user_info]`; f22 `"cli"`
  (originator); f26 ts(ms); f27 tz.
- **user-turn node** — f1 user text; f2 uuid; f4 `1`; f10 ref → context node; f17 uuid.
- **assistant reasoning node** — f3 msg `{ f1: reasoning text, f2: 3 }` (redacted/optional).
- **assistant text node** — f1 msg `{ f1: "ACK …" }`.
- **conversation node** (root f8) — f1 msg `{ f1 ref user-turn, f2 ref reasoning, f2 ref
assistant-text, f3 requestId, f4 <opaque signed token> }`.
- **root** (`latestRootBlobId`) — repeated f1 refs to the flat message list
  `[system_prompt, user_info, user-query, assistant]`; f5 msg = context-budget tree
  (`{ f1 totalTokens, f2 maxTokens, f3 { …, f3[] sections } }` with sections
  `system_prompt / tools / rules / skills / mcp / subagents / summarized_conversation /
conversation`, each `{ f1 id, f2 name, f3 tokens, f4 bytes }`); f8 ref → conversation
  node; f9 `file://<cwd>`; f10 `1`; f21 msg `{ f1 cwd, f2 gitBranch }`; f22 `"cli"`; f26
  ts; f27 tz. (Historical roots are retained as separate blobs; only `latestRootBlobId`
  is loaded.)

### Signed opaque tokens (do not block plaintext rebuild)

The assistant `redacted-reasoning.data` and the conversation node's f4 are opaque,
server-issued tokens (encrypted reasoning / signature). They do **not** contain the
plaintext codename and are **not required** for a synthetic rebuild: the byte-mutated copy
kept them verbatim while swapping only plaintext, and the from-scratch build omitted the
reasoning node and the f4 token entirely — both loaded and recalled correctly. The model's
next-turn recall reads the plaintext conversation, not the signed reasoning.

## Verified REBUILD recipe

### A. Mutate an existing session (lowest risk; proves authority)

1. Copy `~/.cursor/acp-sessions/<src>/` → `<newUuid>/`; delete the copy's `store.db-wal`
   / `store.db-shm`.
2. **Byte-level graph rewrite** (see `rewriteStore` in the probe). Because `id =
sha256(data)`, any content edit changes the blob id and must ripple to the root:
   - Choose a replacement of **exactly equal byte length** so every protobuf length prefix
     stays valid (`EMBER-ORCHID-314` → `QUARTZ-MANTIS-42`, both 16 bytes). Then the whole
     edit is a pure `Buffer` substring swap — no protobuf re-encoding.
   - Fixpoint: repeatedly recompute each blob's new bytes = (text swap) + (replace every
     changed 32-byte old-id with its new id), until the id map stabilises. Converges in a
     few passes (baseline: root plus every ancestor of an edited blob).
3. Update the `meta` row (`agentId = newUuid`, `latestRootBlobId = rewrite(oldRoot)`,
   `name`) — re-hex-encode the JSON — and rewrite `meta.json` (`cwd`, `title`). Every
   inserted blob must still satisfy `id == sha256(data)`.

### B. Author a session from scratch (full REBUILD)

Hand-write the protobuf DAG (`buildSynthetic` in the probe; `build-synth.py` is the
verified reference). Minimal proven-sufficient set:

1. Reuse the real **system_prompt** and **user_info** JSON blobs verbatim (generic
   scaffolding, not conversation) so Composer behaves normally; fabricate everything else.
2. Fabricate the **user query** and **assistant** JSON message blobs (plain `{"type":
"text"}` content — **no** `redacted-reasoning` needed).
3. Build **context node → user-turn node → assistant-text node → conversation node →
   root** as protobuf, hashing each and threading child ids by raw 32 bytes. A minimal f5
   context-budget tree with cosmetic token counts is accepted; the reasoning node and the
   conversation f4 signed token can be omitted.
4. Write a new `store.db` (create `blobs` + `meta`), insert all blobs
   (`id = sha256(data)`), set `meta` row `{ agentId, latestRootBlobId: root, name, mode:
"default", isRunEverything: false, createdAt }` (hex-encoded), and write `meta.json`.

### C. Flip t3code's resume cursor

Resume goes through `parseCursorResume` (`CursorAdapter.ts:173-178`), which requires
exactly:

```json
{ "schemaVersion": 1, "sessionId": "<rebuiltSessionId>" }
```

`CURSOR_RESUME_VERSION` is `1`; a wrong `schemaVersion` or empty `sessionId` is silently
dropped → **fresh session** (see failure modes). The adapter forwards `sessionId` as
`resumeSessionId` to `makeCursorAcpRuntime` → `AcpSessionRuntime` (`CursorAdapter.ts:515,
540`), which issues ACP `session/load { sessionId, cwd, mcpServers }`
(`AcpSessionRuntime.ts:547-552`). On the load path `started.sessionId ===
options.resumeSessionId` (`AcpSessionRuntime.ts:570`) — the id is **not** forked — and the
post-load `ProviderSession.resumeCursor` is `{ schemaVersion: 1, sessionId: rebuiltId }`
(`CursorAdapter.ts:761-764`). So the server flip target is that same cursor object.

Server-level integration mirrors the Claude/Codex notes: stop/quiesce the live session
before writing the store and flipping (the running CLI owns the store.db); the flip must
actively set `resumeCursor` in the binding — `ProviderSessionDirectory.upsert` preserves
the existing cursor when `resumeCursor` is omitted
(`ProviderSessionDirectory.ts:139-142`), and the cursor is persisted as
`resume_cursor_json` (`persistence/ProviderSessionRuntime.ts`).

## Evidence

- **Local authority (decisive, free).** `session/load` on the byte-mutated copy
  `732bf83f` replayed `QUARTZ-MANTIS-42` and **not** `EMBER-ORCHID-314`
  (`mutated-load-replay.txt`). The client sees whatever the local store says.
- **Paid recall — mutated.** Resuming `732bf83f` + "what codename?" →
  `QUARTZ-MANTIS-42` (`state.json → swapMutate`).
- **Paid recall — from scratch.** Resuming hand-authored `1d2c3104` →
  `SABLE-COMET-663`; its free load-replay already showed `SABLE-COMET-663`
  (`synth-load-replay.txt`, `synth-recall-replay.txt`). 9 blobs, all `id == sha256`.
- **Control (paid).** Resuming the unmodified original `c51a13cf` →
  `EMBER-ORCHID-314` (`sanity-recall-replay.txt`). Same load path, real content →
  real answer, isolating content as the only variable.
- **Note on load replay.** `session/load` replay `session/update` notifications are
  swallowed by `AcpSessionRuntime`'s load-gate / `sessionUpdateIsReplay`, so they do
  **not** surface as adapter events — but they ARE visible at the raw protocol layer
  (what the probe captures). Recall the fabricated fact with a real turn to observe it in
  model-visible context, as above.

## Failure modes

- **Unknown sessionId (no store dir).** Direct `session/load` fails loudly with JSON-RPC
  `Invalid params` (-32602); **no** store dir is created and there is **no** silent
  fresh-session fallback at the ACP layer (`state.json → missing`,
  `missing-load-replay.txt`). Unlike Codex's `openCodexThread` "not found" → `thread/start`
  fallback, a missing Cursor session surfaces as a hard error. Prevalidate that
  `~/.cursor/acp-sessions/<id>/store.db` exists before flipping.
- **Malformed cursor at the t3 layer is the dangerous case.** `parseCursorResume` returns
  `undefined` for a wrong `schemaVersion` or non-string/empty `sessionId`
  (`CursorAdapter.ts:173-178`); the adapter then omits `resumeSessionId` and
  `AcpSessionRuntime` takes the `session/new` branch (`AcpSessionRuntime.ts:621-633`) — a
  **silent fresh session**, no error. Validate the cursor shape before handing it over.
- **`store.db-wal` left behind.** If a stale WAL sits next to a store you wrote directly,
  SQLite may present pre-write state on next open. Write with a clean DB and remove
  `-wal`/`-shm` (the probe's `writeStore` does).
- **Length-changing plaintext edits break protobuf.** The equal-length constraint in
  recipe A is load-bearing: a different-length codename would corrupt every enclosing
  length prefix. For arbitrary-length content, re-encode the affected protobuf nodes
  (recipe B path) rather than byte-swapping.

## Commands

```sh
HOOK=./packages/lhc-host/probes/ts-js-resolve-hook.mjs
node --import $HOOK packages/lhc-host/probes/cursor-swap-probe.ts --phase baseline     # paid
node --import $HOOK packages/lhc-host/probes/cursor-swap-probe.ts --phase sanity       # paid (control)
node --import $HOOK packages/lhc-host/probes/cursor-swap-probe.ts --phase mutate       # free
node --import $HOOK packages/lhc-host/probes/cursor-swap-probe.ts --phase swap-mutate  # paid
node --import $HOOK packages/lhc-host/probes/cursor-swap-probe.ts --phase rebuild      # free
node --import $HOOK packages/lhc-host/probes/cursor-swap-probe.ts --phase swap-synth   # paid
node --import $HOOK packages/lhc-host/probes/cursor-swap-probe.ts --phase missing      # free
```

Paid phases are gated by `state.json` so re-runs do not re-spend. `cursor-load-inspect.ts
<sessionId> <cwd> [prompt]` loads any session and dumps the raw replay (load-only = free).

## Deviations / notes

- The pre-existing `cursor-swap-probe.ts` assumed a JSONL transcript at
  `~/.cursor/projects/<hash>/agent-transcripts/<id>/<id>.jsonl` and threw in `baseline`
  because that path never exists. Its `baseline-run.json` was still valid (it captured the
  real sessionId + `ACK EMBER-ORCHID-314`); this probe reused that session id and rewrote
  the file-layer for the real SQLite content-addressed format.
- The from-scratch build was authored/verified in Python first (`build-synth.py`) for fast
  iteration on the protobuf wire format, then ported to TypeScript (`buildSynthetic`,
  `node:sqlite`). Both produce byte-consistent, load-identical stores (TS-built copies were
  free-load-verified to replay the fabricated codename before cleanup).
- Scratch sessions created by this probe and left in `~/.cursor/acp-sessions/`:
  `c51a13cf…` (baseline), `732bf83f…` (mutated), `1d2c3104…` (synthetic). No real session
  was modified in place; nothing was committed.

```

```
