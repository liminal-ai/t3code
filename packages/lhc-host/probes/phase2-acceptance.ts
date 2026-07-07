// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
/**
 * phase2-acceptance — Slice 2.4 live acceptance run.
 *
 * Drives the full LHC compact/prune loop against a live server + real Claude
 * (haiku) sessions and exercises the /lhc HTTP endpoints. Reuses the ws-driver
 * library (connect/monitor/runTurn) and adds:
 *   - context-window (token-usage) snapshot extraction from the subscribeThread
 *     stream (thread.activity-appended / kind "context-window.updated");
 *   - assistant-answer extraction (thread.message-sent, role assistant);
 *   - inline /lhc HTTP calls (GET status, GET thread, POST compact/prune) with
 *     the cached Bearer;
 *   - a busy-check (409) probe by firing compact mid-turn.
 *
 * Writes a single JSON journal (--out). All PASS/FAIL judgement is done by the
 * operator from the journal; this script only gathers evidence.
 *
 * Run under the resolve hook:
 *   node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
 *     packages/lhc-host/probes/phase2-acceptance.ts \
 *     --auth <driver-auth.json> --repo <scratch repo> --out <journal.json> \
 *     [--phase all] [--grow-seq 18000] [--target-tokens 65000] [--max-grow 6]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

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
  type ThreadMonitor,
} from "./ws-driver.ts";

// Local copy (importing ws-scenario.ts would run its top-level CLI main()).
function makeScratchRepo(dir: string): string {
  NodeFS.mkdirSync(dir, { recursive: true });
  const run = (args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  if (!NodeFS.existsSync(NodePath.join(dir, ".git"))) {
    run(["init"]);
    run(["config", "user.email", "probe@example.invalid"]);
    run(["config", "user.name", "LHC Probe"]);
    NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# lhc scratch repo\n");
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

// ---------------------------------------------------------------------------
// Monitor extraction helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

interface TokenUsageSnap {
  usedTokens: number;
  maxTokens?: number;
  compactsAutomatically?: boolean;
  totalProcessedTokens?: number;
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
      ...(typeof p.totalProcessedTokens === "number"
        ? { totalProcessedTokens: p.totalProcessedTokens }
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

/** Final (non-streaming) assistant text for a given turnId (or the last one). */
function assistantAnswer(monitor: ThreadMonitor, turnId: string | null): string | null {
  let answer: string | null = null;
  for (const item of monitor.items) {
    if (!isRecord(item) || item.kind !== "event" || !isRecord(item.event)) continue;
    const event = item.event;
    if (event.type !== "thread.message-sent" || !isRecord(event.payload)) continue;
    const p = event.payload as {
      role?: unknown;
      text?: unknown;
      turnId?: unknown;
      streaming?: unknown;
    };
    if (p.role !== "assistant" || typeof p.text !== "string") continue;
    if (turnId !== null && p.turnId !== turnId) continue;
    // Keep the latest text seen for this turn (streaming settles to final).
    answer = p.text;
  }
  return answer;
}

/** Parse a Claude rollout .jsonl and return its user/assistant text lines. */
function rolloutConversation(path: string): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  const lines = NodeFS.readFileSync(path, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(o) || (o.type !== "user" && o.type !== "assistant")) continue;
    const m = o.message;
    if (!isRecord(m)) continue;
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .map((c) => (isRecord(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
        .join("");
    }
    if (text.trim() === "") continue;
    out.push({ role: String(o.type), text: text.slice(0, 200) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP helpers (/lhc endpoints)
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: unknown;
}

async function lhcGet(origin: string, bearer: string, path: string): Promise<HttpResult> {
  const res = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
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

// ---------------------------------------------------------------------------
// Turn prompts
// ---------------------------------------------------------------------------

const CODENAME = "COPPER-IBIS-42";
const LUCKY = "7391";

const SEED_PROMPT =
  `Remember these two facts for the rest of our conversation: ` +
  `(1) the project codename is ${CODENAME}; (2) the lucky number is ${LUCKY}. ` +
  "Reply with exactly `noted` and nothing else.";

const growPrompt = (n: number): string =>
  `Run the shell command \`seq 1 ${n}\` in this repo. After it finishes, ` +
  "reply with exactly `grew` and nothing else.";

// Prompt-mode growth: a large *user-prompt* reference block. Unlike bash tool
// output (which Claude Code truncates to a ~1k-token tail and drops on the next
// turn), user/assistant conversation text is retained in-context, so this is the
// mechanism that actually drives reported usedTokens up to a substantial peak.
// Lines are index-varied so nothing is deduped away.
function growPromptText(approxTokens: number): string {
  const targetChars = approxTokens * 4;
  const parts: string[] = [
    "Below is a large reference log. Do NOT summarize it; just keep it in mind. " +
      "When you reach the end, reply with exactly `grew` and nothing else.\n\n",
  ];
  let chars = parts[0]!.length;
  let i = 0;
  while (chars < targetChars) {
    const line = `ref-${i} : context-growth filler line ${i} — token ${i * 7 + 3} lorem ipsum dolor sit amet consectetur.\n`;
    parts.push(line);
    chars += line.length;
    i += 1;
  }
  return parts.join("");
}

const RECALL_PROMPT =
  "Without me restating them, what is the project codename and what is the lucky number " +
  "I asked you to remember earlier? Reply with exactly `codename=<X> lucky=<Y>` filling in the values.";

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const flags = parseArgs(process.argv);
  const authFile = str(flags, "auth");
  const repo = str(flags, "repo");
  const outFile = str(flags, "out");
  if (!authFile || !repo || !outFile) {
    throw new Error("need --auth --repo --out");
  }
  const growSeq = num(flags, "grow-seq", 18000);
  const targetTokens = num(flags, "target-tokens", 65000);
  const maxGrow = num(flags, "max-grow", 6);
  const minGrow = num(flags, "min-grow", 4);
  const growMode = str(flags, "grow-mode") === "prompt" ? "prompt" : "seq";
  // In prompt mode, each grow turn's reference block is this many tokens * turn.
  const growTokens = num(flags, "grow-tokens", 30000);

  const auth = JSON.parse(NodeFS.readFileSync(authFile, "utf8")) as {
    origin: string;
    accessToken: string;
  };
  const origin = auth.origin;
  const bearer = auth.accessToken;
  const workspaceRoot = makeScratchRepo(repo);

  const journal: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    origin,
    workspaceRoot,
    params: { growSeq, targetTokens, maxGrow, minGrow, growMode, growTokens },
  };

  const ticket = await mintWsTicket(origin, bearer);

  const program = Effect.scoped(
    Effect.gen(function* () {
      const handle: DriverHandle = yield* connectDriver(origin, ticket);
      const created = yield* createProjectAndThread(handle, {
        workspaceRoot,
        provider: "claude",
        title: "lhc-2.4 acceptance",
      });
      const threadId = created.threadId;
      journal.projectId = created.projectId;
      journal.threadId = threadId;
      console.log(`thread ${threadId}`);

      const monitor = yield* startThreadMonitor(handle, threadId);
      yield* Effect.sleep("500 millis");

      // --- Item 1a: seed turn -------------------------------------------------
      const seed = yield* runTurn(handle, monitor, {
        threadId,
        text: SEED_PROMPT,
        provider: "claude",
      });
      const seedAnswer = assistantAnswer(monitor, seed.turnId);
      journal.seed = {
        turnId: seed.turnId,
        finalStatus: seed.finalStatus,
        answer: seedAnswer,
        tokensAfter: lastUsedTokens(tokenUsageSnaps(monitor)),
      };
      console.log(`seed -> ${seed.finalStatus} answer=${JSON.stringify(seedAnswer)}`);

      // --- Item 1b: grow turns ------------------------------------------------
      // Claude Code drops PRIOR turns' large tool_results from context on the
      // next turn, so context does not accumulate across turns — each turn's
      // reported usedTokens tracks that turn's own tool output. To reach a
      // substantial in-context peak we escalate the single-turn seq size until
      // usedTokens crosses the target (or we exhaust maxGrow).
      const growSizes: number[] = [];
      for (let i = 0; i < maxGrow; i += 1) {
        growSizes.push((growMode === "prompt" ? growTokens : growSeq) * (i + 1));
      }
      const growTurns: Array<Record<string, unknown>> = [];
      for (let i = 0; i < maxGrow; i += 1) {
        const before = monitor.items.length;
        const r = yield* runTurn(handle, monitor, {
          threadId,
          text: growMode === "prompt" ? growPromptText(growSizes[i]!) : growPrompt(growSizes[i]!),
          provider: "claude",
          timeoutMs: 300_000,
        });
        const snaps = tokenUsageSnaps(monitor, before);
        const peak = peakUsedTokens(snaps);
        const last = lastUsedTokens(snaps);
        growTurns.push({
          index: i + 1,
          seqSize: growSizes[i]!,
          turnId: r.turnId,
          finalStatus: r.finalStatus,
          answer: assistantAnswer(monitor, r.turnId),
          peakUsedTokens: peak,
          lastUsedTokens: last,
          compactsAutomatically: snaps.map((s) => s.compactsAutomatically),
          maxTokens: snaps.at(-1)?.maxTokens ?? null,
        });
        const overallPeak = peakUsedTokens(tokenUsageSnaps(monitor));
        console.log(
          `grow ${i + 1} (seq ${growSizes[i]!}) -> ${r.finalStatus} last=${String(last)} peakThisTurn=${peak} overallPeak=${overallPeak}`,
        );
        if (i + 1 >= minGrow && peak >= targetTokens) break;
      }
      const allSnaps = tokenUsageSnaps(monitor);
      journal.grow = {
        turns: growTurns,
        peakUsedTokens: peakUsedTokens(allSnaps),
        allCompactsAutomatically: Array.from(new Set(allSnaps.map((s) => s.compactsAutomatically))),
        snapCount: allSnaps.length,
      };
      console.log(`grow done: peak=${peakUsedTokens(allSnaps)} snaps=${allSnaps.length}`);

      // --- Item 2: status + inspect ------------------------------------------
      const status1 = yield* Effect.promise(() => lhcGet(origin, bearer, "/lhc/status"));
      const inspect1 = yield* Effect.promise(() =>
        lhcGet(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}`),
      );
      journal.statusBeforeCompact = status1;
      journal.inspectBeforeCompact = inspect1;
      console.log(`status ${status1.status}, inspect ${inspect1.status}`);

      // Snapshot native rollout state BEFORE compact for item 6 (compact_boundary
      // scan) — discover the source rollout via the inspect/receipt later.

      // --- Item 3: compact ----------------------------------------------------
      const peakBeforeCompact = peakUsedTokens(tokenUsageSnaps(monitor));
      const compact = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}/compact`, {}),
      );
      journal.compact = compact;
      console.log(`compact -> ${compact.status}`);
      const receipt =
        isRecord(compact.body) && isRecord(compact.body.value)
          ? (compact.body.value as Record<string, unknown>)
          : undefined;
      const rebuiltPath = receipt?.rebuiltPath as string | undefined;
      const oldSessionId = receipt?.oldSessionId as string | undefined;
      const newSessionId = receipt?.newSessionId as string | undefined;

      // capture rebuilt file head + line count
      if (rebuiltPath && NodeFS.existsSync(rebuiltPath)) {
        const lines = NodeFS.readFileSync(rebuiltPath, "utf8").split("\n").filter(Boolean);
        journal.rebuiltFileAfterCompact = {
          path: rebuiltPath,
          exists: true,
          lineCount: lines.length,
          firstLines: lines.slice(0, 3),
        };
      } else {
        journal.rebuiltFileAfterCompact = { path: rebuiltPath ?? null, exists: false };
      }
      journal.compactSessions = { oldSessionId, newSessionId };

      // --- Item 4: resume onto compacted context -----------------------------
      const beforeResume = monitor.items.length;
      const resume = yield* runTurn(handle, monitor, {
        threadId,
        text: RECALL_PROMPT,
        provider: "claude",
      });
      const resumeSnaps = tokenUsageSnaps(monitor, beforeResume);
      journal.resume = {
        turnId: resume.turnId,
        finalStatus: resume.finalStatus,
        answer: assistantAnswer(monitor, resume.turnId),
        usedTokensAfterResume: lastUsedTokens(resumeSnaps),
        peakUsedTokensThisTurn: peakUsedTokens(resumeSnaps),
        peakBeforeCompact,
      };
      console.log(
        `resume -> ${resume.finalStatus} answer=${JSON.stringify(assistantAnswer(monitor, resume.turnId))}`,
      );

      // rebuilt file should have grown (appended new turn). Parse its
      // conversation for the authoritative recall answer (what Claude actually
      // wrote), independent of the streaming monitor extraction.
      if (rebuiltPath && NodeFS.existsSync(rebuiltPath)) {
        const lines = NodeFS.readFileSync(rebuiltPath, "utf8").split("\n").filter(Boolean);
        const convo = rolloutConversation(rebuiltPath);
        const recallLine = convo
          .filter((c) => c.role === "assistant")
          .toReversed()
          .find((c) => /codename/i.test(c.text));
        journal.rebuiltFileAfterResume = {
          path: rebuiltPath,
          lineCount: lines.length,
          conversation: convo,
          recallAnswer: recallLine?.text ?? null,
          recallCorrect:
            recallLine !== undefined &&
            recallLine.text.includes(CODENAME) &&
            recallLine.text.includes(LUCKY),
        };
      }

      // --- Item 5: continuity (2 small turns) --------------------------------
      const contResults: Array<Record<string, unknown>> = [];
      for (let i = 0; i < 2; i += 1) {
        const r = yield* runTurn(handle, monitor, {
          threadId,
          text: "Reply with exactly `ok` and nothing else.",
          provider: "claude",
        });
        contResults.push({
          index: i + 1,
          turnId: r.turnId,
          finalStatus: r.finalStatus,
          answer: assistantAnswer(monitor, r.turnId),
        });
        console.log(`continuity ${i + 1} -> ${r.finalStatus}`);
      }
      journal.continuity = contResults;
      // rebuilt file after continuity
      if (rebuiltPath && NodeFS.existsSync(rebuiltPath)) {
        const lines = NodeFS.readFileSync(rebuiltPath, "utf8").split("\n").filter(Boolean);
        journal.rebuiltFileAfterContinuity = { path: rebuiltPath, lineCount: lines.length };
      }
      // status + inspect after continuity (event count growth, no new lineage)
      journal.statusAfterContinuity = yield* Effect.promise(() =>
        lhcGet(origin, bearer, "/lhc/status"),
      );
      journal.inspectAfterContinuity = yield* Effect.promise(() =>
        lhcGet(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}`),
      );

      // --- Item 8: busy 409 (fire compact mid-turn) --------------------------
      // Dispatch a slow turn (fire-and-forget: the command is accepted, the turn
      // runs on the server). Once the session goes busy, fire compact -> expect
      // 409 busy. Then interrupt/stop and wait for settle. No Effect fork needed.
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
        modelSelection: { instanceId: "claudeAgent", model: "claude-haiku-4-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: nowIso(),
      });
      // wait for the turn to go busy
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
      yield* Effect.sleep("2000 millis");
      const busy = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}/compact`, {}),
      );
      journal.busyCompact = busy;
      journal.busySessionAtFire = monitor.session();
      console.log(`busy compact -> ${busy.status} (session ${JSON.stringify(monitor.session())})`);
      // interrupt the slow turn to save time/cost, then wait for settle
      yield* stopSession(handle, threadId).pipe(Effect.ignore);

      // wait for settle before prune
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

      // --- Item 7: prune ------------------------------------------------------
      const prune = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}/prune`, {}),
      );
      journal.prune = prune;
      console.log(`prune -> ${prune.status}`);
      const pruneReceipt =
        isRecord(prune.body) && isRecord(prune.body.value)
          ? (prune.body.value as Record<string, unknown>)
          : undefined;
      const prunedRebuilt = pruneReceipt?.rebuiltPath as string | undefined;

      // next turn works after prune
      const afterPrune = yield* runTurn(handle, monitor, {
        threadId,
        text: "Reply with exactly `ok` and nothing else.",
        provider: "claude",
      });
      journal.afterPruneTurn = {
        turnId: afterPrune.turnId,
        finalStatus: afterPrune.finalStatus,
        answer: assistantAnswer(monitor, afterPrune.turnId),
      };
      console.log(`afterPrune -> ${afterPrune.finalStatus}`);
      if (prunedRebuilt && NodeFS.existsSync(prunedRebuilt)) {
        const lines = NodeFS.readFileSync(prunedRebuilt, "utf8").split("\n").filter(Boolean);
        journal.prunedRebuiltFile = { path: prunedRebuilt, lineCount: lines.length };
      }

      // --- Item 8: error surfaces (unknown thread -> 404) --------------------
      const unknown = yield* Effect.promise(() =>
        lhcPost(origin, bearer, `/lhc/threads/th_not_a_real_thread_id/compact`, {}),
      );
      journal.unknownCompact = unknown;
      console.log(`unknown compact -> ${unknown.status}`);

      // --- final status/inspect + event counts ------------------------------
      journal.statusFinal = yield* Effect.promise(() => lhcGet(origin, bearer, "/lhc/status"));
      journal.inspectFinal = yield* Effect.promise(() =>
        lhcGet(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}`),
      );
      journal.eventTypeCounts = monitor.eventTypeCounts();

      // stop session
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
