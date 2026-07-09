// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
/**
 * phase4-acceptance — Slice 4.3 Codex live acceptance run.
 *
 * Mirror of phase2-acceptance.ts but drives a **Codex** thread through the full
 * LHC compact/prune loop against a live server + real codex sessions, exercising
 * the /lhc HTTP endpoints (which now route by providerKind). Adds:
 *   - custom model selection (gpt-5.4-mini + reasoningEffort low — cheapest usable);
 *   - codex rollout (session_meta / response_item / event_msg JSONL) parsing +
 *     filename==session_meta id invariant check;
 *   - inline node:sqlite reads of provider_session_runtime (resume_cursor_json,
 *     runtime_payload_json) for the bare {threadId} cursor + cwd-drop checks;
 *   - a quiesced second swap (4.2 cwd-resolution risk item);
 *   - a mixed-provider check: compact on a small CLAUDE thread routes to the
 *     claude flow (dispatch + 4.2 regression proof).
 *
 * All PASS/FAIL judgement is done by the operator from the JSON journal (--out).
 *
 * Run under the resolve hook:
 *   node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
 *     packages/lhc-host/probes/phase4-acceptance.ts \
 *     --auth <driver-auth.json> --repo <scratch repo> --claude-repo <scratch repo> \
 *     --base <t3 base dir> --codex-home <CODEX_HOME> --out <journal.json>
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";

import {
  connectDriver,
  createProjectAndThread,
  dispatch,
  mintWsTicket,
  nowIso,
  runTurn,
  startThreadMonitor,
  stopSession,
  uuid,
  type DriverHandle,
  type ModelSelectionLite,
  type ThreadMonitor,
} from "./ws-driver.ts";

// ---------------------------------------------------------------------------
// Model selection — cheapest usable codex model.
// ---------------------------------------------------------------------------

const CODEX_MODEL: ModelSelectionLite = {
  instanceId: "codex",
  model: "gpt-5.4-mini",
  options: [{ id: "reasoningEffort", value: "low" }],
};

// ---------------------------------------------------------------------------
// Scratch repo helper
// ---------------------------------------------------------------------------

function makeScratchRepo(dir: string): string {
  NodeFS.mkdirSync(dir, { recursive: true });
  const run = (args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  if (!NodeFS.existsSync(NodePath.join(dir, ".git"))) {
    run(["init"]);
    run(["config", "user.email", "probe@example.invalid"]);
    run(["config", "user.name", "LHC Probe"]);
    NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# lhc p4 scratch repo\n");
    run(["add", "README.md"]);
    run(["commit", "-m", "seed"]);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: ReadonlyArray<string>): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags.set(key, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

const str = (flags: Map<string, string | true>, key: string): string | undefined => {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
};
const num = (flags: Map<string, string | true>, key: string, dflt: number): number => {
  const v = str(flags, key);
  return v === undefined ? dflt : Number(v);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// ---------------------------------------------------------------------------
// Monitor extraction helpers
// ---------------------------------------------------------------------------

interface TokenUsageSnap {
  usedTokens: number;
  maxTokens?: number;
  compactsAutomatically?: boolean;
}

/** Pull every context-window.updated activity payload out of the monitor items. */
function tokenUsageSnaps(monitor: ThreadMonitor, fromIndex = 0): TokenUsageSnap[] {
  const out: TokenUsageSnap[] = [];
  const items = monitor.items.slice(fromIndex);
  for (const item of items) {
    if (!isRecord(item) || item.kind !== "event" || !isRecord(item.event)) continue;
    const event = item.event;
    if (event.type !== "thread.activity-appended" || !isRecord(event.payload)) continue;
    const activity = (event.payload as { activity?: unknown }).activity;
    if (!isRecord(activity) || activity.kind !== "context-window.updated") continue;
    const p = activity.payload;
    if (!isRecord(p) || typeof p.usedTokens !== "number") continue;
    out.push({
      usedTokens: p.usedTokens,
      ...(typeof p.maxTokens === "number" ? { maxTokens: p.maxTokens } : {}),
      ...(typeof p.compactsAutomatically === "boolean"
        ? { compactsAutomatically: p.compactsAutomatically }
        : {}),
    });
  }
  return out;
}

function peakUsedTokens(snaps: TokenUsageSnap[]): number {
  return snaps.reduce((m, s) => Math.max(m, s.usedTokens), 0);
}
function lastUsedTokens(snaps: TokenUsageSnap[]): number | null {
  return snaps.length > 0 ? snaps[snaps.length - 1]!.usedTokens : null;
}

/** Collect ALL distinct activity kinds seen (diagnostic — codex may not emit
 * context-window.updated). */
function activityKinds(monitor: ThreadMonitor): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of monitor.items) {
    if (!isRecord(item) || item.kind !== "event" || !isRecord(item.event)) continue;
    const event = item.event;
    if (event.type !== "thread.activity-appended" || !isRecord(event.payload)) continue;
    const activity = (event.payload as { activity?: unknown }).activity;
    if (!isRecord(activity) || typeof activity.kind !== "string") continue;
    counts[activity.kind] = (counts[activity.kind] ?? 0) + 1;
  }
  return counts;
}

/** Final (non-streaming) assistant text for a given turnId (or the last one). */
function assistantAnswer(monitor: ThreadMonitor, turnId: string | null): string | null {
  let answer: string | null = null;
  for (const item of monitor.items) {
    if (!isRecord(item) || item.kind !== "event" || !isRecord(item.event)) continue;
    const event = item.event;
    if (event.type !== "thread.message-sent" || !isRecord(event.payload)) continue;
    const p = event.payload as { role?: unknown; text?: unknown; turnId?: unknown };
    if (p.role !== "assistant" || typeof p.text !== "string") continue;
    if (turnId !== null && p.turnId !== turnId) continue;
    answer = p.text;
  }
  return answer;
}

// ---------------------------------------------------------------------------
// Codex rollout parsing (session_meta / response_item / event_msg JSONL)
// ---------------------------------------------------------------------------

interface CodexRolloutSummary {
  path: string;
  exists: boolean;
  lineCount: number;
  metaSessionId: string | null;
  filenameSessionId: string | null;
  filenameMatchesMeta: boolean | null;
  conversation: Array<{ role: string; text: string }>;
}

function filenameSessionId(path: string): string | null {
  const base = NodePath.basename(path);
  const m = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/u.exec(base);
  return m?.[1] ?? null;
}

function codexRollout(path: string | undefined): CodexRolloutSummary {
  if (!path || !NodeFS.existsSync(path)) {
    return {
      path: path ?? "",
      exists: false,
      lineCount: 0,
      metaSessionId: null,
      filenameSessionId: path ? filenameSessionId(path) : null,
      filenameMatchesMeta: null,
      conversation: [],
    };
  }
  const lines = NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
  let metaSessionId: string | null = null;
  const conversation: Array<{ role: string; text: string }> = [];
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(o)) continue;
    if (o.type === "session_meta" && isRecord(o.payload) && metaSessionId === null) {
      const id = (o.payload as { id?: unknown }).id;
      if (typeof id === "string") metaSessionId = id;
    }
    if (o.type === "response_item" && isRecord(o.payload)) {
      const p = o.payload as { type?: unknown; role?: unknown; content?: unknown };
      if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
        let text = "";
        if (Array.isArray(p.content)) {
          text = p.content
            .map((c) =>
              isRecord(c) &&
              (c.type === "input_text" || c.type === "output_text") &&
              typeof c.text === "string"
                ? c.text
                : "",
            )
            .join("");
        }
        if (text.trim() !== "")
          conversation.push({ role: String(p.role), text: text.slice(0, 240) });
      }
    }
  }
  const fnId = filenameSessionId(path);
  return {
    path,
    exists: true,
    lineCount: lines.length,
    metaSessionId,
    filenameSessionId: fnId,
    filenameMatchesMeta: metaSessionId !== null && fnId !== null ? metaSessionId === fnId : null,
    conversation,
  };
}

// ---------------------------------------------------------------------------
// state.sqlite reads (provider_session_runtime)
// ---------------------------------------------------------------------------

function readProviderRuntime(
  baseDir: string,
  threadId: string,
): { resumeCursor: unknown; runtimePayload: unknown; raw: Record<string, unknown> } | null {
  const dbPath = NodePath.join(baseDir, "userdata", "state.sqlite");
  if (!NodeFS.existsSync(dbPath)) return null;
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT thread_id, resume_cursor_json, runtime_payload_json FROM provider_session_runtime WHERE thread_id = ?",
      )
      .get(threadId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const parse = (v: unknown) => {
      if (typeof v !== "string") return v ?? null;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };
    return {
      resumeCursor: parse(row.resume_cursor_json),
      runtimePayload: parse(row.runtime_payload_json),
      raw: row,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers (/lhc endpoints)
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: unknown;
}

async function lhcGet(origin: string, bearer: string, path: string): Promise<HttpResult> {
  const res = await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function lhcPost(
  origin: string,
  bearer: string,
  path: string,
  payload: unknown = {},
): Promise<HttpResult> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function receiptOf(result: HttpResult): Record<string, unknown> | undefined {
  return isRecord(result.body) && isRecord(result.body.value)
    ? (result.body.value as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// Turn prompts
// ---------------------------------------------------------------------------

const CODENAME = "COBALT-HERON-59";
const LUCKY = "8317";

const SEED_PROMPT =
  `Remember these two facts for the rest of our conversation: ` +
  `(1) the project codename is ${CODENAME}; (2) the lucky number is ${LUCKY}. ` +
  "Reply with exactly `noted` and nothing else. Do not use any tools.";

const growPrompt = (n: number): string =>
  `Run the shell command \`seq 1 ${n}\` in this repo. After it finishes, ` +
  "reply with exactly `grew` and nothing else.";

const RECALL_PROMPT =
  "Without me restating them, what is the project codename and what is the lucky number " +
  "I asked you to remember earlier? Reply with exactly `codename=<X> lucky=<Y>` filling in the " +
  "values. Do not use any tools.";

const OK_PROMPT = "Reply with exactly `ok` and nothing else. Do not use any tools.";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);
  const authFile = str(flags, "auth");
  const repo = str(flags, "repo");
  const claudeRepo = str(flags, "claude-repo");
  const baseDir = str(flags, "base");
  const codexHome = str(flags, "codex-home") ?? NodePath.join(process.env.HOME ?? "", ".codex");
  const outFile = str(flags, "out");
  if (!authFile || !repo || !baseDir || !outFile) {
    throw new Error("need --auth --repo --base --out (optional --claude-repo --codex-home)");
  }
  const growSeq = num(flags, "grow-seq", 20000);
  const maxGrow = num(flags, "max-grow", 4);

  const auth = JSON.parse(NodeFS.readFileSync(authFile, "utf8")) as {
    origin: string;
    accessToken: string;
  };
  const origin = auth.origin;
  const bearer = auth.accessToken;
  const workspaceRoot = makeScratchRepo(repo);
  const codexSessionsDir = NodePath.join(codexHome, "sessions");

  const journal: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    origin,
    workspaceRoot,
    baseDir,
    codexHome,
    model: CODEX_MODEL,
    params: { growSeq, maxGrow },
  };

  const ticket = await mintWsTicket(origin, bearer);

  const program = Effect.scoped(
    Effect.gen(function* () {
      const handle: DriverHandle = yield* connectDriver(origin, ticket);
      const created = yield* createProjectAndThread(handle, {
        workspaceRoot,
        provider: "codex",
        title: "lhc-4.3 codex acceptance",
        modelSelection: CODEX_MODEL,
      });
      const threadId = created.threadId;
      journal.projectId = created.projectId;
      journal.threadId = threadId;
      console.log(`codex thread ${threadId}`);

      const monitor = yield* startThreadMonitor(handle, threadId);
      yield* Effect.sleep("500 millis");

      const codexTurn = (text: string, timeoutMs = 240_000) =>
        runTurn(handle, monitor, {
          threadId,
          text,
          provider: "codex",
          modelSelection: CODEX_MODEL,
          timeoutMs,
        });

      // --- Item 1: grow -----------------------------------------------------
      const seed = yield* codexTurn(SEED_PROMPT);
      journal.seed = {
        turnId: seed.turnId,
        finalStatus: seed.finalStatus,
        answer: assistantAnswer(monitor, seed.turnId),
        tokensAfter: lastUsedTokens(tokenUsageSnaps(monitor)),
      };
      console.log(
        `seed -> ${seed.finalStatus} answer=${JSON.stringify(assistantAnswer(monitor, seed.turnId))}`,
      );

      const growTurns: Array<Record<string, unknown>> = [];
      for (let i = 0; i < maxGrow; i += 1) {
        const before = monitor.items.length;
        const size = growSeq * (i + 1);
        const r = yield* codexTurn(growPrompt(size), 300_000);
        const snaps = tokenUsageSnaps(monitor, before);
        growTurns.push({
          index: i + 1,
          seqSize: size,
          turnId: r.turnId,
          finalStatus: r.finalStatus,
          answer: assistantAnswer(monitor, r.turnId),
          peakUsedTokens: peakUsedTokens(snaps),
          lastUsedTokens: lastUsedTokens(snaps),
        });
        console.log(
          `grow ${i + 1} (seq ${size}) -> ${r.finalStatus} peak=${peakUsedTokens(snaps)}`,
        );
      }
      const allSnaps = tokenUsageSnaps(monitor);
      journal.grow = {
        turns: growTurns,
        peakUsedTokens: peakUsedTokens(allSnaps),
        snapCount: allSnaps.length,
        activityKinds: activityKinds(monitor),
      };

      // --- Item 2: status + inspect -----------------------------------------
      journal.statusBeforeCompact = yield* Effect.promise(() =>
        lhcGet(origin, bearer, "/lhc/status"),
      );
      const inspect1 = yield* Effect.promise(() =>
        lhcGet(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}`),
      );
      journal.inspectBeforeCompact = inspect1;
      const tokensBeforeCompact = peakUsedTokens(tokenUsageSnaps(monitor));

      // --- Item 3: compact --------------------------------------------------
      const compact = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}/compact`, {}),
      );
      journal.compact = compact;
      console.log(`compact -> ${compact.status}`);
      const receipt = receiptOf(compact);
      const rebuiltPath = receipt?.rebuiltPath as string | undefined;
      const newSessionId = receipt?.newSessionId as string | undefined;
      journal.rebuiltAfterCompact = codexRollout(rebuiltPath);
      // persisted cursor + runtimePayload snapshot
      journal.bindingAfterCompact = readProviderRuntime(baseDir, threadId);
      // path-under-dated-dir check: <codexSessionsDir>/YYYY/MM/DD/rollout-...
      journal.rebuiltUnderDatedDir =
        rebuiltPath !== undefined &&
        rebuiltPath.startsWith(`${codexSessionsDir}/`) &&
        /\/sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-/u.test(rebuiltPath);

      // --- Item 4: resume onto compacted context ----------------------------
      const beforeResume = monitor.items.length;
      const resume = yield* codexTurn(RECALL_PROMPT);
      const resumeSnaps = tokenUsageSnaps(monitor, beforeResume);
      journal.resume = {
        turnId: resume.turnId,
        finalStatus: resume.finalStatus,
        answer: assistantAnswer(monitor, resume.turnId),
        usedTokensAfterResume: lastUsedTokens(resumeSnaps),
        tokensBeforeCompact,
      };
      const rebuiltAfterResume = codexRollout(rebuiltPath);
      const recallLine = rebuiltAfterResume.conversation
        .filter((c) => c.role === "assistant")
        .toReversed()
        .find((c) => /codename/i.test(c.text) || new RegExp(CODENAME).test(c.text));
      journal.rebuiltAfterResume = {
        ...rebuiltAfterResume,
        recallAnswer: recallLine?.text ?? null,
        recallCorrect:
          recallLine !== undefined &&
          recallLine.text.includes(CODENAME) &&
          recallLine.text.includes(LUCKY),
      };
      console.log(
        `resume -> ${resume.finalStatus} answer=${JSON.stringify(assistantAnswer(monitor, resume.turnId))} recallCorrect=${journal.rebuiltAfterResume && (journal.rebuiltAfterResume as any).recallCorrect}`,
      );

      // --- Item 5: continuity (2 small turns) -------------------------------
      const contResults: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 2; i += 1) {
        const r = yield* codexTurn(OK_PROMPT);
        contResults.push({
          index: i + 1,
          turnId: r.turnId,
          finalStatus: r.finalStatus,
          answer: assistantAnswer(monitor, r.turnId),
        });
        console.log(`continuity ${i + 1} -> ${r.finalStatus}`);
      }
      journal.continuity = contResults;
      journal.rebuiltAfterContinuity = codexRollout(rebuiltPath);
      journal.statusAfterContinuity = yield* Effect.promise(() =>
        lhcGet(origin, bearer, "/lhc/status"),
      );
      journal.inspectAfterContinuity = yield* Effect.promise(() =>
        lhcGet(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}`),
      );

      // --- Item 6: second swap on a QUIESCED thread (4.2 cwd-resolution risk)
      // Stop the session explicitly; do NOT send any turn; then fire compact.
      yield* stopSession(handle, threadId).pipe(Effect.ignore);
      yield* Effect.promise(() =>
        monitor
          .waitUntil(
            (m) =>
              m.session().activeTurnId === null &&
              m.session().status !== "running" &&
              m.session().status !== "starting",
            30_000,
          )
          .catch(() => undefined),
      );
      yield* Effect.sleep("1500 millis");
      // capture binding state at the moment before the quiesced compact
      journal.bindingBeforeQuiescedCompact = readProviderRuntime(baseDir, threadId);
      journal.sessionAtQuiescedCompact = monitor.session();
      const quiescedCompact = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}/compact`, {}),
      );
      journal.quiescedCompact = quiescedCompact;
      console.log(`quiesced compact -> ${quiescedCompact.status}`);
      const quiescedReceipt = receiptOf(quiescedCompact);
      const quiescedRebuilt = quiescedReceipt?.rebuiltPath as string | undefined;
      journal.rebuiltAfterQuiescedCompact = codexRollout(quiescedRebuilt);
      journal.bindingAfterQuiescedCompact = readProviderRuntime(baseDir, threadId);
      // next turn works after the quiesced swap?
      if (quiescedCompact.status === 200) {
        const afterQuiesced = yield* codexTurn(OK_PROMPT);
        journal.afterQuiescedTurn = {
          turnId: afterQuiesced.turnId,
          finalStatus: afterQuiesced.finalStatus,
          answer: assistantAnswer(monitor, afterQuiesced.turnId),
        };
        console.log(`afterQuiesced turn -> ${afterQuiesced.finalStatus}`);
      }

      // --- Item 7: prune ----------------------------------------------------
      // ensure idle
      yield* stopSession(handle, threadId).pipe(Effect.ignore);
      yield* Effect.promise(() =>
        monitor
          .waitUntil(
            (m) =>
              m.session().activeTurnId === null &&
              m.session().status !== "running" &&
              m.session().status !== "starting",
            30_000,
          )
          .catch(() => undefined),
      );
      yield* Effect.sleep("1000 millis");
      const prune = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}/prune`, {}),
      );
      journal.prune = prune;
      console.log(`prune -> ${prune.status}`);
      const pruneReceipt = receiptOf(prune);
      journal.prunedRebuilt = codexRollout(pruneReceipt?.rebuiltPath as string | undefined);
      journal.bindingAfterPrune = readProviderRuntime(baseDir, threadId);
      if (prune.status === 200) {
        const afterPrune = yield* codexTurn(OK_PROMPT);
        journal.afterPruneTurn = {
          turnId: afterPrune.turnId,
          finalStatus: afterPrune.finalStatus,
          answer: assistantAnswer(monitor, afterPrune.turnId),
        };
        console.log(`afterPrune turn -> ${afterPrune.finalStatus}`);
      }

      // --- Item 8a: unknown thread -> 404 -----------------------------------
      journal.unknownCompact = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/th_not_a_real_thread_id/compact`, {}),
      );
      console.log(`unknown compact -> ${(journal.unknownCompact as HttpResult).status}`);

      // --- Item 8b: busy 409 (fire compact mid in-flight turn) --------------
      yield* dispatch(handle, {
        type: "thread.turn.start",
        commandId: uuid(),
        threadId,
        message: {
          messageId: uuid(),
          role: "user",
          text:
            "Run this shell command exactly and wait for it: " +
            "`for i in $(seq 1 30); do echo slow-$i; sleep 1; done`. Do not stop until it completes.",
          attachments: [],
        },
        modelSelection: CODEX_MODEL,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: nowIso(),
      });
      yield* Effect.promise(() =>
        monitor
          .waitUntil(
            (m) =>
              m.session().activeTurnId !== null &&
              (m.session().status === "running" || m.session().status === "starting"),
            60_000,
          )
          .catch(() => undefined),
      );
      yield* Effect.sleep("2500 millis");
      const busy = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}/compact`, {}),
      );
      journal.busyCompact = busy;
      journal.busySessionAtFire = monitor.session();
      console.log(`busy compact -> ${busy.status} (session ${JSON.stringify(monitor.session())})`);
      yield* stopSession(handle, threadId).pipe(Effect.ignore);
      yield* Effect.promise(() =>
        monitor
          .waitUntil(
            (m) =>
              m.session().activeTurnId === null &&
              m.session().status !== "running" &&
              m.session().status !== "starting",
            60_000,
          )
          .catch(() => undefined),
      );

      // --- Item 8c: mixed-provider — compact a small CLAUDE thread ----------
      if (claudeRepo) {
        const claudeWorkspace = makeScratchRepo(claudeRepo);
        const claudeCreated = yield* createProjectAndThread(handle, {
          workspaceRoot: claudeWorkspace,
          provider: "claude",
          title: "lhc-4.3 claude mixed-provider",
        });
        const claudeThreadId = claudeCreated.threadId;
        journal.claudeThreadId = claudeThreadId;
        const claudeMonitor = yield* startThreadMonitor(handle, claudeThreadId);
        yield* Effect.sleep("500 millis");
        const claudeSeed = yield* runTurn(handle, claudeMonitor, {
          threadId: claudeThreadId,
          text: SEED_PROMPT,
          provider: "claude",
        });
        journal.claudeSeed = {
          turnId: claudeSeed.turnId,
          finalStatus: claudeSeed.finalStatus,
          answer: assistantAnswer(claudeMonitor, claudeSeed.turnId),
        };
        const claudeCompact = yield* Effect.promise(() =>
          lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(claudeThreadId)}/compact`, {}),
        );
        journal.claudeCompact = claudeCompact;
        console.log(`claude(mixed) compact -> ${claudeCompact.status}`);
        const claudeReceipt = receiptOf(claudeCompact);
        journal.claudeCompactRebuiltPath = claudeReceipt?.rebuiltPath ?? null;
        // a claude rollout is per-cwd under ~/.claude/projects; just record existence
        const cPath = claudeReceipt?.rebuiltPath as string | undefined;
        journal.claudeRebuiltExists = cPath ? NodeFS.existsSync(cPath) : false;
        yield* stopSession(handle, claudeThreadId).pipe(Effect.ignore);
      }

      // --- final status/inspect ---------------------------------------------
      journal.statusFinal = yield* Effect.promise(() => lhcGet(origin, bearer, "/lhc/status"));
      journal.inspectFinal = yield* Effect.promise(() =>
        lhcGet(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}`),
      );
      journal.eventTypeCounts = monitor.eventTypeCounts();

      yield* stopSession(handle, threadId).pipe(Effect.ignore);
      yield* Effect.sleep("1500 millis");
    }),
  );

  await Effect.runPromise(program as Effect.Effect<void, unknown, never>);

  journal.finishedAt = new Date().toISOString();
  NodeFS.writeFileSync(outFile, `${JSON.stringify(journal, null, 2)}\n`);
  console.log(`\nwrote journal ${outFile}`);
}

main().then(
  () => {
    setTimeout(() => process.exit(0), 200);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
