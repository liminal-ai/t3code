// Scratch probe for Slice 0.3 Claude session-swap recipe.
// Excluded from package checks because packages/lhc-host/tsconfig.json includes only src/.
//
// Phases (run from repo root):
//   node packages/lhc-host/probes/claude-swap-probe.ts --phase baseline
//   node packages/lhc-host/probes/claude-swap-probe.ts --phase rebuild   (no provider session)
//   node packages/lhc-host/probes/claude-swap-probe.ts --phase swap
//   node packages/lhc-host/probes/claude-swap-probe.ts --phase missing
//
// State is threaded between phases via test/fixtures/claude-swap/state.json.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  ClaudeSettings,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "../../contracts/src/index.ts";
import * as NodeServices from "../../../apps/server/node_modules/@effect/platform-node/dist/NodeServices.js";
import * as Cause from "../../../apps/server/node_modules/effect/dist/Cause.js";
import * as Effect from "../../../apps/server/node_modules/effect/dist/Effect.js";
import * as Exit from "../../../apps/server/node_modules/effect/dist/Exit.js";
import * as Fiber from "../../../apps/server/node_modules/effect/dist/Fiber.js";
import * as Layer from "../../../apps/server/node_modules/effect/dist/Layer.js";
import * as Option from "../../../apps/server/node_modules/effect/dist/Option.js";
import * as Schema from "../../../apps/server/node_modules/effect/dist/Schema.js";
import * as Stream from "../../../apps/server/node_modules/effect/dist/Stream.js";

import { ServerConfig } from "../../../apps/server/src/config.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import { ProviderSessionDirectory } from "../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts";
import { makeClaudeAdapter } from "../../../apps/server/src/provider/Layers/ClaudeAdapter.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeModelSelection = Schema.decodeSync(ModelSelection);

const INSTANCE_ID = "claudeAgent";
const CHEAP_MODEL = "claude-haiku-4-5-20251001";
const FACT_ORIGINAL = "AZURE-FALCON-42";
const FACT_REBUILT = "BRONZE-HERON-77";
const OUT_DIR = NodePath.join(process.cwd(), "packages/lhc-host/test/fixtures/claude-swap");
const STATE_PATH = NodePath.join(OUT_DIR, "state.json");
const PROJECTS_ROOT = NodePath.join(NodeOS.homedir(), ".claude", "projects");

const providerSessionDirectoryProbeLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () => Effect.succeed(Option.none()),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

interface ProbeState {
  cwd?: string;
  baselineThreadId?: string;
  baselineSessionId?: string;
  baselineRolloutPath?: string;
  baselineStartCursor?: unknown;
  baselineFinalCursor?: unknown;
  rebuiltSessionId?: string;
  rebuiltRolloutPath?: string;
  rebuiltLineCount?: number;
  swap?: Record<string, unknown>;
  missing?: Record<string, unknown>;
}

function readState(): ProbeState {
  try {
    return JSON.parse(NodeFS.readFileSync(STATE_PATH, "utf8")) as ProbeState;
  } catch {
    return {};
  }
}

function writeState(state: ProbeState): void {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  NodeFS.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function makeScratchRepo(): string {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-swap-"));
  NodeChildProcess.execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "probe@example.invalid"], { cwd });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "Claude Swap Probe"], { cwd });
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "# claude swap probe\n");
  NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "seed"], { cwd, stdio: "ignore" });
  return cwd;
}

// Claude Code encodes the project cwd by replacing every non [A-Za-z0-9-] char
// with "-" (cc-lhc rollout/discover.ts encodeProjectPath). We search as a
// fallback in case the encoding differs.
function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

function findRolloutPath(cwd: string, sessionId: string): string | undefined {
  const direct = NodePath.join(PROJECTS_ROOT, encodeProjectPath(cwd), `${sessionId}.jsonl`);
  if (NodeFS.existsSync(direct)) return direct;
  for (const dir of NodeFS.readdirSync(PROJECTS_ROOT)) {
    const candidate = NodePath.join(PROJECTS_ROOT, dir, `${sessionId}.jsonl`);
    if (NodeFS.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function appendJsonl(filePath: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface EventLog {
  readonly events: Array<Record<string, unknown>>;
  readonly completions: Map<string, unknown>;
}

function waitForTurn(log: EventLog, turnId: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (log.completions.has(turnId)) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for turn ${turnId}`));
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

function assistantTextForTurn(log: EventLog, turnId: string): string {
  const chunks: string[] = [];
  for (const event of log.events) {
    if (event.type !== "item.completed" || String(event.turnId) !== turnId) continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload.detail === "string" && payload.itemType === "assistant_message") {
      chunks.push(payload.detail);
    }
  }
  return chunks.join("\n");
}

function providerThreadIds(log: EventLog): string[] {
  const ids: string[] = [];
  for (const event of log.events) {
    if (event.type !== "thread.started") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload.providerThreadId === "string") {
      ids.push(payload.providerThreadId);
    }
  }
  return ids;
}

const makeAdapterWithLog = Effect.fn("makeAdapterWithLog")(function* (label: string) {
  const adapter = yield* makeClaudeAdapter(decodeClaudeSettings({}), {
    instanceId: ProviderInstanceId.make(INSTANCE_ID),
    nativeEventLogPath: NodePath.join(OUT_DIR, `${label}-native.log`),
  });
  const eventsPath = NodePath.join(OUT_DIR, `${label}-normalized.jsonl`);
  NodeFS.rmSync(eventsPath, { force: true });
  const log: EventLog = { events: [], completions: new Map() };
  const streamFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.sync(() => {
      appendJsonl(eventsPath, event);
      log.events.push(event as unknown as Record<string, unknown>);
      if ((event.type === "turn.completed" || event.type === "turn.aborted") && event.turnId) {
        log.completions.set(String(event.turnId), event);
      }
    }),
  ).pipe(Effect.forkChild);
  return { adapter, log, streamFiber };
});

// ── Phase: baseline ─────────────────────────────────────────────────────────

const runBaseline = Effect.gen(function* () {
  const cwd = makeScratchRepo();
  const threadId = ThreadId.make(`claude-swap-baseline-${Date.now()}`);
  const { adapter, log, streamFiber } = yield* makeAdapterWithLog("baseline");

  const session = yield* adapter.startSession({
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make(INSTANCE_ID),
    threadId,
    cwd,
    modelSelection: decodeModelSelection({ instanceId: INSTANCE_ID, model: CHEAP_MODEL }),
    runtimeMode: "full-access",
  });
  console.log("startSession resumeCursor:", JSON.stringify(session.resumeCursor));

  const start = yield* adapter.sendTurn({
    threadId,
    input: `Remember this fact for the rest of the session: the deployment codename is ${FACT_ORIGINAL}. Reply with exactly \`noted\` and nothing else. Do not use any tools.`,
    attachments: [],
  });
  yield* Effect.tryPromise(() => waitForTurn(log, String(start.turnId), 240_000));

  const live = yield* adapter.listSessions();
  const finalCursor = live.find((s) => s.threadId === threadId)?.resumeCursor;
  console.log("post-turn resumeCursor:", JSON.stringify(finalCursor));

  yield* adapter.stopSession(threadId).pipe(Effect.ignore);
  yield* Fiber.interrupt(streamFiber).pipe(Effect.ignore);
  yield* Effect.promise(() => sleep(1_000));

  const cursor = (finalCursor ?? session.resumeCursor) as { resume?: string } | undefined;
  const sessionId = cursor?.resume;
  if (!sessionId) throw new Error("No resume session id captured");
  const rolloutPath = findRolloutPath(cwd, sessionId);
  console.log("baseline sessionId:", sessionId);
  console.log("baseline rolloutPath:", rolloutPath);
  console.log("provider thread ids:", providerThreadIds(log));
  console.log("assistant said:", assistantTextForTurn(log, String(start.turnId)));

  const state = readState();
  writeState({
    ...state,
    cwd,
    baselineThreadId: threadId,
    baselineSessionId: sessionId,
    baselineRolloutPath: rolloutPath,
    baselineStartCursor: session.resumeCursor,
    baselineFinalCursor: finalCursor,
  });
});

// ── Phase: rebuild (no provider session) ────────────────────────────────────

interface RolloutLine {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  session_id?: string;
  isSidechain?: boolean;
  cwd?: string;
  timestamp?: string;
  version?: string;
  gitBranch?: string;
  userType?: string;
  entrypoint?: string;
  message?: Record<string, unknown>;
  [key: string]: unknown;
}

function extractText(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

// Line shapes follow the proven cc-lhc rebuilder
// (liminal-context/packages/cc-lhc/src/rollout/rebuild.ts): a minimal
// user/assistant envelope with a fresh uuid chain rooted at parentUuid=null.
function runRebuild(): void {
  const state = readState();
  if (!state.baselineRolloutPath || !state.cwd) {
    throw new Error("Run --phase baseline first");
  }
  const sourceLines = NodeFS.readFileSync(state.baselineRolloutPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RolloutLine);

  // Envelope fields from the newest user/assistant line of the real rollout.
  const envelopeSource = [...sourceLines]
    .toReversed()
    .find((line) => line.type === "user" || line.type === "assistant");
  if (!envelopeSource) throw new Error("No user/assistant line in baseline rollout");
  const assistantSource = [...sourceLines].toReversed().find((line) => line.type === "assistant");
  const assistantModel = (assistantSource?.message?.model as string | undefined) ?? CHEAP_MODEL;

  const newSessionId = NodeCrypto.randomUUID();
  const timestamp = new Date().toISOString();
  const rebuilt: RolloutLine[] = [];
  let parentUuid: string | null = null;

  const baseFields = (): RolloutLine => {
    const line: RolloutLine = {
      type: "user",
      uuid: NodeCrypto.randomUUID(),
      parentUuid,
      sessionId: newSessionId,
      isSidechain: false,
      cwd: state.cwd,
      timestamp,
    };
    if (envelopeSource.version !== undefined) line.version = envelopeSource.version;
    if (envelopeSource.gitBranch !== undefined) line.gitBranch = envelopeSource.gitBranch;
    if (envelopeSource.userType !== undefined) line.userType = envelopeSource.userType;
    if (envelopeSource.entrypoint !== undefined) line.entrypoint = envelopeSource.entrypoint;
    if (envelopeSource.session_id !== undefined) line.session_id = newSessionId;
    return line;
  };

  const pushUser = (text: string): void => {
    const line = baseFields();
    line.type = "user";
    line.message = { role: "user", content: text };
    rebuilt.push(line);
    parentUuid = line.uuid ?? null;
  };
  const pushAssistant = (text: string): void => {
    const line = baseFields();
    line.type = "assistant";
    line.message = {
      role: "assistant",
      id: `msg_${(line.uuid ?? "").replace(/-/g, "")}`,
      type: "message",
      model: assistantModel,
      stop_reason: "end_turn",
      content: [{ type: "text", text }],
    };
    rebuilt.push(line);
    parentUuid = line.uuid ?? null;
  };

  // Replay the real conversation with the planted fact swapped.
  for (const line of sourceLines) {
    if (line.type !== "user" && line.type !== "assistant") continue;
    if (line.toolUseResult !== undefined) continue; // tool results: none expected, skip if present
    const text = extractText(line.message).replaceAll(FACT_ORIGINAL, FACT_REBUILT);
    if (text === "") continue;
    if (line.type === "user") pushUser(text);
    else pushAssistant(text);
  }
  // A synthetic exchange that never happened in the real session.
  pushUser("Confirm the deployment codename one more time.");
  pushAssistant(`The deployment codename is ${FACT_REBUILT}.`);

  const rolloutDir = NodePath.dirname(state.baselineRolloutPath);
  const rebuiltPath = NodePath.join(rolloutDir, `${newSessionId}.jsonl`);
  NodeFS.writeFileSync(rebuiltPath, rebuilt.map((line) => JSON.stringify(line)).join("\n") + "\n");
  // Deliberately NOT touching sessions-index.json (experiment step 4).

  console.log("rebuilt sessionId:", newSessionId);
  console.log("rebuilt rolloutPath:", rebuiltPath);
  console.log("rebuilt lineCount:", rebuilt.length);
  writeState({
    ...state,
    rebuiltSessionId: newSessionId,
    rebuiltRolloutPath: rebuiltPath,
    rebuiltLineCount: rebuilt.length,
  });
}

// ── Phase: swap ─────────────────────────────────────────────────────────────

const runSwap = Effect.gen(function* () {
  const state = readState();
  if (!state.rebuiltSessionId || !state.rebuiltRolloutPath || !state.cwd) {
    throw new Error("Run --phase rebuild first");
  }
  const linesBefore = NodeFS.readFileSync(state.rebuiltRolloutPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;

  const threadId = ThreadId.make(`claude-swap-swap-${Date.now()}`);
  const { adapter, log, streamFiber } = yield* makeAdapterWithLog("swap");

  const session = yield* adapter.startSession({
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make(INSTANCE_ID),
    threadId,
    cwd: state.cwd,
    modelSelection: decodeModelSelection({ instanceId: INSTANCE_ID, model: CHEAP_MODEL }),
    resumeCursor: { resume: state.rebuiltSessionId },
    runtimeMode: "full-access",
  });
  console.log("swap startSession resumeCursor:", JSON.stringify(session.resumeCursor));

  const start = yield* adapter.sendTurn({
    threadId,
    input:
      "What is the deployment codename? Answer with only the codename, no other text. Do not use any tools.",
    attachments: [],
  });
  yield* Effect.tryPromise(() => waitForTurn(log, String(start.turnId), 240_000));

  const answer = assistantTextForTurn(log, String(start.turnId));
  const live = yield* adapter.listSessions();
  const finalCursor = live.find((s) => s.threadId === threadId)?.resumeCursor;

  yield* adapter.stopSession(threadId).pipe(Effect.ignore);
  yield* Fiber.interrupt(streamFiber).pipe(Effect.ignore);
  yield* Effect.promise(() => sleep(2_000));

  const linesAfter = NodeFS.readFileSync(state.rebuiltRolloutPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "").length;
  const result = {
    answer,
    verdict: answer.includes(FACT_REBUILT)
      ? "SUCCESS: rebuilt file content recalled"
      : answer.includes(FACT_ORIGINAL)
        ? "FAILURE: original session content recalled"
        : "INCONCLUSIVE",
    startCursor: session.resumeCursor,
    finalCursor,
    providerThreadIds: providerThreadIds(log),
    rebuiltFileLinesBefore: linesBefore,
    rebuiltFileLinesAfter: linesAfter,
    rebuiltFileGrew: linesAfter > linesBefore,
  };
  console.log(JSON.stringify(result, null, 2));
  writeState({ ...state, swap: result });
});

// ── Phase: missing (resume uuid with no rollout file) ───────────────────────

const runMissing = Effect.gen(function* () {
  const state = readState();
  if (!state.cwd) throw new Error("Run --phase baseline first");
  const ghostSessionId = NodeCrypto.randomUUID();
  const threadId = ThreadId.make(`claude-swap-missing-${Date.now()}`);
  const { adapter, log, streamFiber } = yield* makeAdapterWithLog("missing");

  const result: Record<string, unknown> = { ghostSessionId };
  const startExit = yield* adapter
    .startSession({
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make(INSTANCE_ID),
      threadId,
      cwd: state.cwd,
      modelSelection: decodeModelSelection({ instanceId: INSTANCE_ID, model: CHEAP_MODEL }),
      resumeCursor: { resume: ghostSessionId },
      runtimeMode: "full-access",
    })
    .pipe(Effect.exit);
  result.startSessionOutcome = Exit.isSuccess(startExit)
    ? { status: "succeeded", resumeCursor: startExit.value.resumeCursor }
    : { status: "failed", cause: Cause.pretty(startExit.cause) };

  if (Exit.isSuccess(startExit)) {
    const sendExit = yield* adapter
      .sendTurn({
        threadId,
        input:
          "What is the deployment codename? If you do not know, say exactly `no idea`. Do not use any tools.",
        attachments: [],
      })
      .pipe(Effect.exit);
    if (Exit.isSuccess(sendExit)) {
      const turnId = String(sendExit.value.turnId);
      const waitExit = yield* Effect.tryPromise(() => waitForTurn(log, turnId, 120_000)).pipe(
        Effect.exit,
      );
      result.turnOutcome = Exit.isSuccess(waitExit)
        ? {
            status: "completed",
            completion: log.completions.get(turnId),
            answer: assistantTextForTurn(log, turnId),
          }
        : { status: "timed-out-or-failed", cause: Cause.pretty(waitExit.cause) };
    } else {
      result.turnOutcome = { status: "sendTurn-failed", cause: Cause.pretty(sendExit.cause) };
    }
    const live = yield* adapter.listSessions();
    result.finalCursor = live.find((s) => s.threadId === threadId)?.resumeCursor;
    yield* adapter.stopSession(threadId).pipe(Effect.ignore);
  }
  yield* Fiber.interrupt(streamFiber).pipe(Effect.ignore);
  yield* Effect.promise(() => sleep(1_000));

  result.errorEvents = log.events.filter(
    (event) => String(event.type).includes("error") || String(event.type).includes("failed"),
  );
  result.ghostRolloutCreated = findRolloutPath(state.cwd, ghostSessionId) ?? false;
  console.log(JSON.stringify(result, null, 2));
  writeState({ ...state, missing: result });
});

// ── Entry ───────────────────────────────────────────────────────────────────

const phaseArg = process.argv.includes("--phase")
  ? process.argv[process.argv.indexOf("--phase") + 1]
  : undefined;

if (phaseArg === "rebuild") {
  runRebuild();
  process.exit(0);
}

const phaseEffect =
  phaseArg === "baseline"
    ? runBaseline
    : phaseArg === "swap"
      ? runSwap
      : phaseArg === "missing"
        ? runMissing
        : undefined;
if (!phaseEffect) {
  console.error("Usage: node claude-swap-probe.ts --phase baseline|rebuild|swap|missing");
  process.exit(2);
}

const main = phaseEffect.pipe(
  Effect.provide(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), process.cwd()),
      ServerSettingsService.layerTest(),
      providerSessionDirectoryProbeLayer,
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

Effect.runPromiseExit(Effect.scoped(main)).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause));
    process.exit(1);
  }
  // The Claude SDK query runtime can keep the process alive; exit explicitly
  // once all phase output has been flushed (same lingering seen in slice 0.2).
  process.exit(0);
});
