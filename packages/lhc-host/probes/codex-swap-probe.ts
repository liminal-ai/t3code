// Scratch probe for Slice 4.0 Codex synthetic-rollout resume.
// Excluded from package checks because packages/lhc-host/tsconfig.json includes only src/.
//
// Run from repo root:
//   node packages/lhc-host/probes/codex-swap-probe.ts
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CodexSettings,
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
import * as Scope from "../../../apps/server/node_modules/effect/dist/Scope.js";
import * as Stream from "../../../apps/server/node_modules/effect/dist/Stream.js";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "../../../apps/server/node_modules/effect-codex-app-server/src/client.ts";

import { ServerConfig } from "../../../apps/server/src/config.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import { ProviderSessionDirectory } from "../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts";
import { makeCodexAdapter } from "../../../apps/server/src/provider/Layers/CodexAdapter.ts";
import { buildCodexInitializeParams } from "../../../apps/server/src/provider/Layers/CodexProvider.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const INSTANCE_ID = "codex";
const FACT_ORIGINAL = "SILVER-HARBOR-31";
const FACT_SYNTH_SAME = "BRONZE-HARBOR-77";
const FACT_SYNTH_FRESH = "COPPER-LANTERN-88";
const CHECKSUM_SYNTH = "314159";
const OUT_DIR = NodePath.join(process.cwd(), "packages/lhc-host/test/fixtures/codex-swap");
const STATE_PATH = NodePath.join(OUT_DIR, "state.json");

const providerSessionDirectoryProbeLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () => Effect.succeed(Option.none()),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

interface ProbeState {
  codexVersion?: string;
  codexHome?: string;
  cwd?: string;
  baseline?: Record<string, unknown>;
  sanity?: Record<string, unknown>;
  syntheticSameProcess?: Record<string, unknown>;
  syntheticFreshProcess?: Record<string, unknown>;
  failureModes?: Record<string, unknown>;
  forkBonus?: Record<string, unknown>;
}

interface AdapterEventLog {
  readonly events: Array<Record<string, unknown>>;
  readonly completions: Map<string, unknown>;
}

interface DirectLog {
  readonly events: Array<Record<string, unknown>>;
  readonly completions: Map<string, unknown>;
}

function writeState(state: ProbeState): void {
  NodeFS.mkdirSync(OUT_DIR, { recursive: true });
  NodeFS.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function readState(): ProbeState | undefined {
  try {
    return JSON.parse(NodeFS.readFileSync(STATE_PATH, "utf8")) as ProbeState;
  } catch {
    return undefined;
  }
}

function appendJsonl(filePath: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyIfExists(from: string, to: string): void {
  if (!NodeFS.existsSync(from)) return;
  NodeFS.mkdirSync(NodePath.dirname(to), { recursive: true });
  NodeFS.cpSync(from, to, { recursive: true });
}

function makeTempCodexHome(): string {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-swap-home-"));
  const source = NodePath.join(NodeOS.homedir(), ".codex");
  for (const name of [
    "auth.json",
    "config.toml",
    "installation_id",
    "models_cache.json",
    "model-catalog.override.json",
    "version.json",
  ]) {
    copyIfExists(NodePath.join(source, name), NodePath.join(home, name));
  }
  return home;
}

function makeScratchRepo(): string {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-swap-cwd-"));
  NodeChildProcess.execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "probe@example.invalid"], {
    cwd,
  });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "Codex Swap Probe"], { cwd });
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "# codex swap probe\n");
  NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "seed"], { cwd, stdio: "ignore" });
  return cwd;
}

function waitForTurn(
  completions: Map<string, unknown>,
  turnId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (completions.has(turnId)) return resolve();
      if (Date.now() - started > timeoutMs) {
        return reject(new Error(`Timed out waiting for turn ${turnId}`));
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

function assistantTextFromAdapterLog(log: AdapterEventLog, turnId: string): string {
  const chunks: string[] = [];
  for (const event of log.events) {
    if (event.type !== "item.completed" || String(event.turnId) !== turnId) continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload?.itemType === "assistant_message" && typeof payload.detail === "string") {
      chunks.push(payload.detail);
    }
  }
  return chunks.join("\n");
}

function assistantTextFromDirectLog(log: DirectLog, turnId: string): string {
  const chunks: string[] = [];
  for (const event of log.events) {
    if (event.method !== "item/completed") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload?.turnId !== turnId) continue;
    const item = payload.item as Record<string, unknown> | undefined;
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      chunks.push(item.text);
    }
  }
  return chunks.join("\n");
}

function providerThreadIds(log: AdapterEventLog): string[] {
  const ids: string[] = [];
  for (const event of log.events) {
    if (event.type !== "thread.started") continue;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (typeof payload?.providerThreadId === "string") ids.push(payload.providerThreadId);
  }
  return ids;
}

function findRolloutPath(home: string, sessionId: string): string | undefined {
  const root = NodePath.join(home, "sessions");
  if (!NodeFS.existsSync(root)) return undefined;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of NodeFS.readdirSync(current, { withFileTypes: true })) {
      const full = NodePath.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(`${sessionId}.jsonl`)) {
        return full;
      }
    }
  }
  return undefined;
}

function lineCount(filePath: string): number {
  return NodeFS.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "").length;
}

function firstSessionMeta(filePath: string): Record<string, unknown> | undefined {
  for (const raw of NodeFS.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type === "session_meta" && typeof parsed.payload === "object") {
      return parsed.payload as Record<string, unknown>;
    }
  }
  return undefined;
}

function localRolloutStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-") +
    `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  );
}

function rolloutPathFor(home: string, sessionId: string, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = String(date.getFullYear());
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  return NodePath.join(
    home,
    "sessions",
    year,
    month,
    day,
    `rollout-${localRolloutStamp(date)}-${sessionId}.jsonl`,
  );
}

function syntheticRolloutContent(input: {
  readonly sessionId: string;
  readonly cwd: string;
  readonly fact: string;
  readonly sourceMeta?: Record<string, unknown>;
  readonly corruptFirstLine?: boolean;
  readonly corruptSecondLine?: boolean;
  readonly metaSessionId?: string;
}): string {
  const base = Date.now();
  let tick = 0;
  const timestamp = () => new Date(base + tick++).toISOString();
  const metaTimestamp = timestamp();
  const sessionId = input.metaSessionId ?? input.sessionId;
  const sourceMeta = input.sourceMeta ?? {};
  const meta: Record<string, unknown> = {
    session_id: sessionId,
    id: sessionId,
    timestamp: metaTimestamp,
    cwd: input.cwd,
    originator: "t3code-swap-probe",
    source: "vscode",
    thread_source: "user",
    model_provider: "openai",
  };
  if (typeof sourceMeta.cli_version === "string") meta.cli_version = sourceMeta.cli_version;
  if (sourceMeta.base_instructions !== undefined) {
    meta.base_instructions = sourceMeta.base_instructions;
  }
  const user = `Synthetic prior fact: deployment codename ${input.fact}; checksum ${CHECKSUM_SYNTH}.`;
  const assistant = `Recorded: ${input.fact} with checksum ${CHECKSUM_SYNTH}.`;
  const lines = [
    {
      timestamp: metaTimestamp,
      type: "session_meta",
      payload: meta,
    },
    {
      timestamp: timestamp(),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: user }],
      },
    },
    {
      timestamp: timestamp(),
      type: "event_msg",
      payload: {
        type: "user_message",
        message: user,
        images: [],
        local_images: [],
        text_elements: [],
      },
    },
    {
      timestamp: timestamp(),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistant }],
        phase: "final_answer",
      },
    },
    {
      timestamp: timestamp(),
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: assistant,
        phase: "final_answer",
        memory_citation: null,
      },
    },
  ];
  const serialized = lines.map((line) => JSON.stringify(line));
  if (input.corruptFirstLine) {
    serialized[0] = "{not-json";
  }
  if (input.corruptSecondLine) {
    serialized[1] = "{not-json";
  }
  return `${serialized.join("\n")}\n`;
}

function writeSyntheticRollout(input: {
  readonly home: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly fact: string;
  readonly sourceMeta?: Record<string, unknown>;
  readonly corruptFirstLine?: boolean;
  readonly corruptSecondLine?: boolean;
  readonly metaSessionId?: string;
}): string {
  const filePath = rolloutPathFor(input.home, input.sessionId);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, syntheticRolloutContent(input));
  return filePath;
}

const makeAdapterWithLog = Effect.fn("makeAdapterWithLog")(function* (
  homePath: string,
  label: string,
) {
  const adapter = yield* makeCodexAdapter(
    decodeCodexSettings({
      homePath,
      binaryPath: "codex",
    }),
    {
      instanceId: ProviderInstanceId.make(INSTANCE_ID),
      nativeEventLogPath: NodePath.join(OUT_DIR, `${label}-native.log`),
    },
  );
  const eventsPath = NodePath.join(OUT_DIR, `${label}-normalized.jsonl`);
  NodeFS.rmSync(eventsPath, { force: true });
  const log: AdapterEventLog = { events: [], completions: new Map() };
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

const withDirectClient = Effect.fn("withDirectClient")(function* <A>(input: {
  readonly homePath: string;
  readonly cwd: string;
  readonly label: string;
  readonly run: (
    client: CodexClient.CodexAppServerClient["Service"],
    log: DirectLog,
  ) => Effect.Effect<A, unknown>;
}) {
  const scope = yield* Scope.make("sequential");
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const log: DirectLog = { events: [], completions: new Map() };
  const logPath = NodePath.join(OUT_DIR, `${input.label}-direct.jsonl`);
  NodeFS.rmSync(logPath, { force: true });
  const child = yield* spawner.spawn(
    ChildProcess.make("codex", ["app-server"], {
      cwd: input.cwd,
      env: { ...process.env, CODEX_HOME: input.homePath },
      forceKillAfter: "2 seconds",
    }),
  );
  const context = yield* CodexClient.layerChildProcess(child).pipe(Layer.buildWithScope(scope));
  const result = yield* Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const record = (method: string, payload: unknown) =>
      Effect.sync(() => {
        const event = { method, payload };
        appendJsonl(logPath, event);
        log.events.push(event);
        const maybePayload = payload as Record<string, unknown> | undefined;
        const turn = maybePayload?.turn as Record<string, unknown> | undefined;
        if (method === "turn/completed" && typeof turn?.id === "string") {
          log.completions.set(turn.id, event);
        }
      });

    for (const method of [
      "thread/started",
      "thread/status/changed",
      "thread/name/updated",
      "thread/tokenUsage/updated",
      "turn/started",
      "turn/completed",
      "item/started",
      "item/completed",
      "item/agentMessage/delta",
      "error",
    ]) {
      yield* (client.handleServerNotification as any)(method, (payload: unknown) =>
        record(method, payload),
      );
    }

    yield* client.handleUnknownServerRequest((method, params) =>
      record(`request:${method}`, params).pipe(Effect.as({})),
    );
    yield* client.request("initialize", buildCodexInitializeParams());
    yield* client.notify("initialized", undefined);
    return yield* input.run(client, log);
  }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
  return result;
});

function threadOpenParams(cwd: string) {
  return {
    cwd,
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  } as const;
}

function turnStartParams(threadId: string, prompt: string) {
  return {
    threadId,
    input: [{ type: "text", text: prompt }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  } as const;
}

const runAdapterBaseline = Effect.fn("runAdapterBaseline")(function* (
  homePath: string,
  cwd: string,
) {
  const threadId = ThreadId.make(`codex-swap-baseline-${Date.now()}`);
  const { adapter, log, streamFiber } = yield* makeAdapterWithLog(homePath, "baseline");
  const session = yield* adapter.startSession({
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make(INSTANCE_ID),
    threadId,
    cwd,
    runtimeMode: "full-access",
  });

  const seed = yield* adapter.sendTurn({
    threadId,
    attachments: [],
    input: `Remember this exact deployment codename: ${FACT_ORIGINAL}; gate number 4812. Reply exactly noted. Do not use tools.`,
  });
  yield* Effect.tryPromise(() => waitForTurn(log.completions, String(seed.turnId), 240_000));

  const check = yield* adapter.sendTurn({
    threadId,
    attachments: [],
    input: "What gate number did I give you? Reply with digits only. Do not use tools.",
  });
  yield* Effect.tryPromise(() => waitForTurn(log.completions, String(check.turnId), 240_000));

  const live = yield* adapter.listSessions();
  const finalSession = live.find((item) => item.threadId === threadId);
  yield* adapter.stopSession(threadId).pipe(Effect.ignore);
  yield* Fiber.interrupt(streamFiber).pipe(Effect.ignore);
  yield* Effect.promise(() => sleep(1_000));

  const providerThreadId = (finalSession?.resumeCursor as { threadId?: string } | undefined)
    ?.threadId;
  if (!providerThreadId) throw new Error("No Codex provider thread id captured");
  const rolloutPath = findRolloutPath(homePath, providerThreadId);
  if (!rolloutPath) throw new Error(`No rollout found for ${providerThreadId}`);
  return {
    t3ThreadId: threadId,
    startCursor: session.resumeCursor,
    finalCursor: finalSession?.resumeCursor,
    providerThreadId,
    rolloutPath,
    lineCount: lineCount(rolloutPath),
    providerThreadIds: providerThreadIds(log),
    checkAnswer: assistantTextFromAdapterLog(log, String(check.turnId)),
  };
});

const runAdapterSanityResume = Effect.fn("runAdapterSanityResume")(function* (
  homePath: string,
  cwd: string,
  resumeThreadId: string,
) {
  const threadId = ThreadId.make(`codex-swap-sanity-${Date.now()}`);
  const { adapter, log, streamFiber } = yield* makeAdapterWithLog(homePath, "sanity");
  const session = yield* adapter.startSession({
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make(INSTANCE_ID),
    threadId,
    cwd,
    runtimeMode: "full-access",
    resumeCursor: { threadId: resumeThreadId },
  });
  const recall = yield* adapter.sendTurn({
    threadId,
    attachments: [],
    input:
      "What deployment codename did I ask you to remember? Reply codename only. Do not use tools.",
  });
  yield* Effect.tryPromise(() => waitForTurn(log.completions, String(recall.turnId), 240_000));
  const live = yield* adapter.listSessions();
  const finalSession = live.find((item) => item.threadId === threadId);
  yield* adapter.stopSession(threadId).pipe(Effect.ignore);
  yield* Fiber.interrupt(streamFiber).pipe(Effect.ignore);
  yield* Effect.promise(() => sleep(1_000));
  return {
    t3ThreadId: threadId,
    startCursor: session.resumeCursor,
    finalCursor: finalSession?.resumeCursor,
    answer: assistantTextFromAdapterLog(log, String(recall.turnId)),
  };
});

const runSyntheticSameProcess = Effect.fn("runSyntheticSameProcess")(function* (
  homePath: string,
  cwd: string,
  sourceMeta: Record<string, unknown> | undefined,
) {
  const syntheticId = NodeCrypto.randomUUID();
  const result = yield* withDirectClient({
    homePath,
    cwd,
    label: "synthetic-same-process",
    run: (client, log) =>
      Effect.gen(function* () {
        const warm = yield* client.request("thread/start", threadOpenParams(cwd));
        const rolloutPath = writeSyntheticRollout({
          home: homePath,
          cwd,
          sessionId: syntheticId,
          fact: FACT_SYNTH_SAME,
          ...(sourceMeta ? { sourceMeta } : {}),
        });
        const beforeLineCount = lineCount(rolloutPath);
        const resumed = yield* client.request("thread/resume", {
          threadId: syntheticId,
          ...threadOpenParams(cwd),
        });
        const response = yield* client.request(
          "turn/start",
          turnStartParams(
            resumed.thread.id,
            "What deployment codename is in the earlier synthetic history? Reply codename only. Do not use tools.",
          ),
        );
        yield* Effect.tryPromise(() =>
          waitForTurn(log.completions, String(response.turn.id), 240_000),
        );
        return {
          warmThreadId: warm.thread.id,
          syntheticId,
          rolloutPath,
          beforeLineCount,
          afterLineCount: lineCount(rolloutPath),
          resumedThreadId: resumed.thread.id,
          turnId: response.turn.id,
          answer: assistantTextFromDirectLog(log, response.turn.id),
        };
      }),
  });
  return result;
});

const runSyntheticFreshProcess = Effect.fn("runSyntheticFreshProcess")(function* (
  homePath: string,
  cwd: string,
  sourceMeta: Record<string, unknown> | undefined,
) {
  const syntheticId = NodeCrypto.randomUUID();
  const rolloutPath = writeSyntheticRollout({
    home: homePath,
    cwd,
    sessionId: syntheticId,
    fact: FACT_SYNTH_FRESH,
    ...(sourceMeta ? { sourceMeta } : {}),
  });
  const beforeLineCount = lineCount(rolloutPath);
  const result = yield* withDirectClient({
    homePath,
    cwd,
    label: "synthetic-fresh-process",
    run: (client, log) =>
      Effect.gen(function* () {
        const resumed = yield* client.request("thread/resume", {
          threadId: syntheticId,
          ...threadOpenParams(cwd),
        });
        const response = yield* client.request(
          "turn/start",
          turnStartParams(
            resumed.thread.id,
            "What deployment codename is in the earlier synthetic history? Reply codename only. Do not use tools.",
          ),
        );
        yield* Effect.tryPromise(() =>
          waitForTurn(log.completions, String(response.turn.id), 240_000),
        );
        return {
          syntheticId,
          rolloutPath,
          beforeLineCount,
          afterLineCount: lineCount(rolloutPath),
          resumedThreadId: resumed.thread.id,
          turnId: response.turn.id,
          answer: assistantTextFromDirectLog(log, response.turn.id),
        };
      }),
  });
  return result;
});

const captureResumeOutcome = Effect.fn("captureResumeOutcome")(function* (
  homePath: string,
  cwd: string,
  label: string,
  threadId: string,
) {
  return yield* withDirectClient({
    homePath,
    cwd,
    label,
    run: (client) =>
      client
        .request("thread/resume", {
          threadId,
          ...threadOpenParams(cwd),
        })
        .pipe(
          Effect.map((response) => ({
            ok: true,
            threadId: response.thread.id,
            path: response.thread.path,
            preview: response.thread.preview,
            turnCount: response.thread.turns.length,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false,
              name: error instanceof Error ? error.name : undefined,
              message: error instanceof Error ? error.message : String(error),
              error: String(error),
            }),
          ),
        ),
  });
});

const runFailureModes = Effect.fn("runFailureModes")(function* (
  homePath: string,
  cwd: string,
  sourceMeta: Record<string, unknown> | undefined,
) {
  const missingId = NodeCrypto.randomUUID();
  const missing = yield* captureResumeOutcome(homePath, cwd, "missing", missingId);

  const malformedId = NodeCrypto.randomUUID();
  const malformedPath = writeSyntheticRollout({
    home: homePath,
    cwd,
    sessionId: malformedId,
    fact: "MALFORMED",
    corruptFirstLine: true,
    ...(sourceMeta ? { sourceMeta } : {}),
  });
  const malformed = yield* captureResumeOutcome(homePath, cwd, "malformed", malformedId);

  const malformedLaterId = NodeCrypto.randomUUID();
  const malformedLaterPath = writeSyntheticRollout({
    home: homePath,
    cwd,
    sessionId: malformedLaterId,
    fact: "MALFORMED-LATER",
    corruptSecondLine: true,
    ...(sourceMeta ? { sourceMeta } : {}),
  });
  const malformedLater = yield* captureResumeOutcome(
    homePath,
    cwd,
    "malformed-later",
    malformedLaterId,
  );

  const filenameId = NodeCrypto.randomUUID();
  const metaId = NodeCrypto.randomUUID();
  const mismatchPath = writeSyntheticRollout({
    home: homePath,
    cwd,
    sessionId: filenameId,
    metaSessionId: metaId,
    fact: "MISMATCH",
    ...(sourceMeta ? { sourceMeta } : {}),
  });
  const mismatch = yield* captureResumeOutcome(homePath, cwd, "id-mismatch", filenameId);

  return {
    missingId,
    missing,
    malformedId,
    malformedPath,
    malformed,
    malformedLaterId,
    malformedLaterPath,
    malformedLater,
    filenameId,
    metaId,
    mismatchPath,
    mismatch,
  };
});

const runForkBonus = Effect.fn("runForkBonus")(function* (
  homePath: string,
  cwd: string,
  sourceThreadId: string,
) {
  return yield* withDirectClient({
    homePath,
    cwd,
    label: "fork-synthetic",
    run: (client) =>
      client
        .request("thread/fork", {
          threadId: sourceThreadId,
          ...threadOpenParams(cwd),
        })
        .pipe(
          Effect.map((response) => ({
            ok: true,
            sourceThreadId,
            threadId: response.thread.id,
            path: response.thread.path,
            forkedFromId: response.thread.forkedFromId,
            preview: response.thread.preview,
            turnCount: response.thread.turns.length,
          })),
          Effect.catch((error) =>
            Effect.succeed({
              ok: false,
              sourceThreadId,
              name: error instanceof Error ? error.name : undefined,
              message: error instanceof Error ? error.message : String(error),
              error: String(error),
            }),
          ),
        ),
  });
});

const main = Effect.gen(function* () {
  let state = readState();
  if (!state) {
    NodeFS.rmSync(OUT_DIR, { recursive: true, force: true });
    NodeFS.mkdirSync(OUT_DIR, { recursive: true });
    state = {
      codexVersion: NodeChildProcess.execFileSync("codex", ["--version"], {
        encoding: "utf8",
      }).trim(),
      codexHome: makeTempCodexHome(),
      cwd: makeScratchRepo(),
    };
  }
  const codexHome = state.codexHome ?? makeTempCodexHome();
  const cwd = state.cwd ?? makeScratchRepo();
  state.codexHome = codexHome;
  state.cwd = cwd;
  writeState(state);

  const baseline =
    state.baseline ??
    (yield* runAdapterBaseline(codexHome, cwd).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          state.baseline = result;
          writeState(state);
        }),
      ),
    ));

  if (!state.sanity) {
    const sanity = yield* runAdapterSanityResume(
      codexHome,
      cwd,
      baseline.providerThreadId as string,
    );
    state.sanity = sanity;
    writeState(state);
  }

  const sourceMeta = firstSessionMeta(baseline.rolloutPath as string);
  if (!state.syntheticSameProcess) {
    const same = yield* runSyntheticSameProcess(codexHome, cwd, sourceMeta);
    state.syntheticSameProcess = same as Record<string, unknown>;
    writeState(state);
  }

  if (!state.syntheticFreshProcess) {
    const fresh = yield* runSyntheticFreshProcess(codexHome, cwd, sourceMeta);
    state.syntheticFreshProcess = fresh as Record<string, unknown>;
    writeState(state);
  }

  if (!state.failureModes?.malformedLater) {
    const failureModes = yield* runFailureModes(codexHome, cwd, sourceMeta);
    state.failureModes = failureModes;
    writeState(state);
  }

  if (!state.forkBonus && state.syntheticFreshProcess?.syntheticId) {
    const forkBonus = yield* runForkBonus(
      codexHome,
      cwd,
      String(state.syntheticFreshProcess.syntheticId),
    );
    state.forkBonus = forkBonus as Record<string, unknown>;
    writeState(state);
  }
}).pipe(
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
    process.exitCode = 1;
  } else {
    console.log(`wrote ${STATE_PATH}`);
  }
});
