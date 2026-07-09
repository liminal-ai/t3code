// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
/**
 * sync-smoke — one-command acceptance gate for upstream syncs.
 *
 * Boots a scratch server, drives real Claude + Codex turns, verifies capture,
 * runs compact (Claude) / prune (Codex), verifies resume, and tears down.
 *
 *   node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
 *     packages/lhc-host/smoke/sync-smoke.ts [--skip-codex] [--skip-claude] [--keep]
 *
 * Exit 0 = certified, exit 1 = broken. Writes docs/lhc/sync-reports/<stamp>.md.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";

import {
  connectDriver,
  createProjectAndThread,
  mintWsTicket,
  resolveRuntimeState,
  runTurn,
  startThreadMonitor,
  stopSession,
  type ModelSelectionLite,
  type ProviderName,
  type ThreadMonitor,
} from "../probes/ws-driver.ts";
import { verifyCapture } from "./capture.ts";
import { derivationFromInspect, formatHttpEvidence, lhcGet, lhcPost, receiptOf } from "./http.ts";
import {
  assistantAnswerFromItems,
  formatFailuresStderr,
  formatReportMarkdown,
  formatReportTableStdout,
  formatReportTimestamp,
  judgeCaptureCheck,
  judgeDerivationStatus,
  judgeResumeResult,
  judgeSwapResult,
  pickFreePort,
  sessionIdFromCursor,
  verifyServerIdentity,
  type SmokeProvider,
  type SmokeReportInput,
  type SmokeStepResult,
} from "./lib.ts";
import { readProviderRuntime } from "./runtime.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TURN_TIMEOUT_MS = 120_000;
const MAX_PAID_TURNS = 8;
const DERIVATION_WAIT_CAP_MS = 60_000;
const RUNTIME_WAIT_MS = 30_000;
const SERVER_KILL_GRACE_MS = 10_000;
const SEQ_SIZE = 2000;
const MIN_TOOL_BYTES = 8_000;

const REPO_ROOT = NodePath.resolve(NodePath.dirname(new URL(import.meta.url).pathname), "../../..");
const RESOLVE_HOOK = NodePath.join(REPO_ROOT, "packages/lhc-host/probes/ts-js-resolve-hook.mjs");
const SERVER_BIN = NodePath.join(REPO_ROOT, "apps/server/src/bin.ts");
const REPORTS_DIR = NodePath.join(REPO_ROOT, "docs/lhc/sync-reports");

const CODEX_MODEL: ModelSelectionLite = {
  instanceId: "codex",
  model: "gpt-5.4-mini",
  options: [{ id: "reasoningEffort", value: "low" }],
};

const PROVIDER_CODENAMES: Record<SmokeProvider, string> = {
  claude: "COPPER-IBIS-42",
  codex: "COBALT-HERON-59",
};

const SWAP_OP: Record<SmokeProvider, "compact" | "prune"> = {
  claude: "compact",
  codex: "prune",
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: ReadonlyArray<string>): {
  skipClaude: boolean;
  skipCodex: boolean;
  keep: boolean;
} {
  const flags = new Set(argv.slice(2));
  return {
    skipClaude: flags.has("--skip-claude"),
    skipCodex: flags.has("--skip-codex"),
    keep: flags.has("--keep"),
  };
}

// ---------------------------------------------------------------------------
// Scratch repo (from ws-scenario / phase2)
// ---------------------------------------------------------------------------

function makeScratchRepo(dir: string): string {
  NodeFS.mkdirSync(dir, { recursive: true });
  const run = (args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  if (!NodeFS.existsSync(NodePath.join(dir, ".git"))) {
    run(["init"]);
    run(["config", "user.email", "sync-smoke@example.invalid"]);
    run(["config", "user.name", "LHC Sync Smoke"]);
    NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# lhc sync-smoke scratch\n");
    run(["add", "README.md"]);
    run(["commit", "-m", "seed"]);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Monitor helpers (from phase2 / phase4)
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

class SmokeStepError extends Error {
  readonly evidence: string;

  constructor(message: string, evidence: string) {
    super(message);
    this.name = "SmokeStepError";
    this.evidence = evidence;
  }
}

function failStep(message: string, evidence: unknown): never {
  throw new SmokeStepError(
    message,
    typeof evidence === "string" ? evidence : JSON.stringify(evidence, null, 2),
  );
}

interface TurnObservation {
  readonly label: string;
  readonly turnId: string | null;
  readonly finalStatus: string;
  readonly answer: string | null;
}

function formatTurnEvidence(
  provider: SmokeProvider,
  monitor: ThreadMonitor | undefined,
  observations: ReadonlyArray<TurnObservation>,
): string {
  if (!monitor) {
    return JSON.stringify({ provider, observations, monitor: "not started" }, null, 2);
  }

  const relevantEvents = monitor.items
    .filter(
      (item) =>
        isRecord(item) &&
        item.kind === "event" &&
        isRecord(item.event) &&
        (item.event.type === "thread.session-set" ||
          item.event.type === "thread.message-sent" ||
          item.event.type === "thread.activity-appended"),
    )
    .slice(-12)
    .map((item) => {
      const event = (item as { event: Record<string, unknown> }).event;
      const payload = isRecord(event.payload) ? event.payload : {};
      if (event.type === "thread.message-sent") {
        return {
          type: event.type,
          role: payload.role,
          turnId: payload.turnId,
          streaming: payload.streaming,
          text:
            typeof payload.text === "string"
              ? payload.text.slice(-500)
              : String(payload.text ?? ""),
        };
      }
      if (event.type === "thread.session-set") {
        return { type: event.type, session: payload.session };
      }
      const activity = isRecord(payload.activity) ? payload.activity : {};
      return {
        type: event.type,
        activity: {
          kind: activity.kind,
          summary: activity.summary,
          turnId: activity.turnId,
          tone: activity.tone,
        },
      };
    });

  return JSON.stringify(
    {
      provider,
      observations,
      finalSession: monitor.session(),
      lastAssistantMessage: assistantAnswerFromItems(monitor.items, null),
      eventTypeCounts: monitor.eventTypeCounts(),
      relevantEvents,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Server boot + auth (operations.md + ws-scenario auth)
// ---------------------------------------------------------------------------

interface ServerHandle {
  readonly child: NodeChildProcess.ChildProcess;
  readonly port: number;
  readonly spawnTimeMs: number;
  readonly logTail: () => string;
}

function spawnServer(port: number, baseDir: string, lhcHome: string): ServerHandle {
  const spawnTimeMs = Date.now();
  const logLines: string[] = [];
  const pushLog = (chunk: Buffer | string): void => {
    const text = String(chunk);
    for (const line of text.split("\n")) {
      if (line.trim() !== "") {
        logLines.push(line);
        if (logLines.length > 200) logLines.shift();
      }
    }
  };

  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--import",
      RESOLVE_HOOK,
      SERVER_BIN,
      "serve",
      "--port",
      String(port),
      "--base-dir",
      baseDir,
      "--host",
      "127.0.0.1",
    ],
    {
      env: { ...process.env, T3CODE_LHC_HOME: lhcHome },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", pushLog);
  child.stderr?.on("data", pushLog);

  return {
    child,
    port,
    spawnTimeMs,
    logTail: () => logLines.slice(-40).join("\n"),
  };
}

async function waitForRuntime(
  baseDir: string,
  lhcHome: string,
  server: ServerHandle,
): Promise<{ origin: string; bearer: string }> {
  const deadline = Date.now() + RUNTIME_WAIT_MS;
  let lastReason = "runtime.json not found";

  while (Date.now() < deadline) {
    const runtimePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
    if (NodeFS.existsSync(runtimePath)) {
      try {
        const runtime = resolveRuntimeState(baseDir);
        const identity = verifyServerIdentity({
          runtime,
          expectedPid: server.child.pid ?? -1,
          spawnTimeMs: server.spawnTimeMs,
        });
        if (!identity.ok) {
          lastReason = identity.reason;
        } else {
          const bearer = NodeChildProcess.execFileSync(
            process.execPath,
            [
              "--import",
              RESOLVE_HOOK,
              SERVER_BIN,
              "auth",
              "session",
              "issue",
              "--token-only",
              "--base-dir",
              baseDir,
            ],
            {
              encoding: "utf8",
              env: { ...process.env, T3CODE_LHC_HOME: lhcHome },
            },
          ).trim();
          return { origin: runtime.origin, bearer };
        }
      } catch (error) {
        lastReason = String(error);
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server boot timeout: ${lastReason}`);
}

async function killServer(server: ServerHandle | null): Promise<void> {
  if (!server?.child.pid) return;
  const { child } = server;
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), SERVER_KILL_GRACE_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  if (!exited && child.pid) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already dead
    }
  }
}

function removeDir(dir: string | null): void {
  if (!dir || !NodeFS.existsSync(dir)) return;
  NodeFS.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Turn budget
// ---------------------------------------------------------------------------

class TurnBudget {
  private count = 0;

  charge(): void {
    this.count += 1;
    if (this.count > MAX_PAID_TURNS) {
      throw new Error(
        `paid turn budget exceeded: ${String(this.count)} > ${String(MAX_PAID_TURNS)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

class StepRunner {
  readonly steps: SmokeStepResult[] = [];
  private claudeTurns = 0;
  private codexTurns = 0;

  async run<T>(
    id: string,
    label: string,
    fn: () => Promise<T>,
    opts: { provider?: SmokeProvider; onFailEvidence?: (error: unknown) => string } = {},
  ): Promise<T | undefined> {
    const start = performance.now();
    try {
      const value = await fn();
      this.steps.push({
        id,
        label,
        ...(opts.provider ? { provider: opts.provider } : {}),
        status: "PASS",
        durationMs: performance.now() - start,
      });
      return value;
    } catch (error) {
      const evidence =
        opts.onFailEvidence?.(error) ??
        (error instanceof SmokeStepError
          ? error.evidence
          : error instanceof Error
            ? (error.stack ?? error.message)
            : String(error));
      this.steps.push({
        id,
        label,
        ...(opts.provider ? { provider: opts.provider } : {}),
        status: "FAIL",
        durationMs: performance.now() - start,
        detail: error instanceof Error ? error.message : String(error),
        evidence,
      });
      return undefined;
    }
  }

  skip(id: string, label: string, provider?: SmokeProvider): void {
    this.steps.push({
      id,
      label,
      ...(provider ? { provider } : {}),
      status: "SKIP",
      durationMs: 0,
      detail: "skipped via flag",
    });
  }

  noteTurn(provider: SmokeProvider): void {
    if (provider === "claude") this.claudeTurns += 1;
    else this.codexTurns += 1;
  }

  turnCounts(): { claudeTurns: number; codexTurns: number } {
    return { claudeTurns: this.claudeTurns, codexTurns: this.codexTurns };
  }

  overallPass(): boolean {
    return !this.steps.some((s) => s.status === "FAIL");
  }
}

// ---------------------------------------------------------------------------
// Provider flow
// ---------------------------------------------------------------------------

function seedPrompt(codename: string): string {
  return (
    `Remember this fact for the rest of our conversation: the project codename is ${codename}. ` +
    "Reply with exactly `noted` and nothing else."
  );
}

const SMALL_PROMPT = "Reply with exactly `ok` and nothing else.";

function seqPrompt(n: number): string {
  return (
    `Run the shell command \`seq 1 ${String(n)}\` in this repo. After it finishes, ` +
    "reply with exactly `last number: " +
    String(n) +
    "` and nothing else."
  );
}

function recallPrompt(): string {
  return (
    "Without me restating it, what is the project codename I asked you to remember earlier? " +
    "Reply with exactly `codename=<X>` filling in the value."
  );
}

async function waitDerivationsOk(origin: string, bearer: string, threadId: string): Promise<void> {
  const deadline = Date.now() + DERIVATION_WAIT_CAP_MS;
  let lastResult: Awaited<ReturnType<typeof lhcGet>> | undefined;
  while (Date.now() < deadline) {
    const inspect = await lhcGet(origin, bearer, `/lhc/threads/${encodeURIComponent(threadId)}`);
    lastResult = inspect;
    const d = derivationFromInspect(inspect.body);
    if (d.failed >= 0 && d.blocked >= 0) {
      const judgement = judgeDerivationStatus(d);
      if (judgement.pass) return;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  failStep(
    `derivations not settled within ${String(DERIVATION_WAIT_CAP_MS / 1000)}s: ${JSON.stringify(derivationFromInspect(lastResult?.body))}`,
    lastResult ? formatHttpEvidence(lastResult) : "no inspect response",
  );
}

interface ProviderTurnContext {
  readonly threadId: string;
  readonly resumeAnswer: string | null;
  readonly turnEvidence: string;
}

async function driveProviderTurns(input: {
  provider: SmokeProvider;
  origin: string;
  bearer: string;
  workspaceRoot: string;
  runner: StepRunner;
  budget: TurnBudget;
  threadId?: string;
}): Promise<ProviderTurnContext | undefined> {
  const { provider, origin, bearer, workspaceRoot, budget } = input;
  const codename = PROVIDER_CODENAMES[provider];
  const providerName: ProviderName = provider;
  const modelSelection = provider === "codex" ? CODEX_MODEL : undefined;
  const ticket = await mintWsTicket(origin, bearer);

  let threadId = input.threadId;
  let resumeAnswer: string | null = null;
  let monitorForEvidence: ThreadMonitor | undefined;
  const observations: TurnObservation[] = [];

  const program = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* connectDriver(origin, ticket);
      let activeThreadId = threadId;
      let monitor: ThreadMonitor;

      if (!activeThreadId) {
        const created = yield* createProjectAndThread(handle, {
          workspaceRoot,
          provider: providerName,
          title: `sync-smoke ${provider}`,
          ...(modelSelection ? { modelSelection } : {}),
        });
        activeThreadId = created.threadId;
        monitor = yield* startThreadMonitor(handle, activeThreadId);
        monitorForEvidence = monitor;
        yield* Effect.sleep("500 millis");

        const paidTurn = (label: string, text: string, expectedAnswer: string) => {
          budget.charge();
          input.runner.noteTurn(provider);
          return runTurn(handle, monitor, {
            threadId: activeThreadId!,
            text,
            provider: providerName,
            timeoutMs: TURN_TIMEOUT_MS,
            ...(modelSelection ? { modelSelection } : {}),
          }).pipe(
            Effect.timeout(`${String(TURN_TIMEOUT_MS)} millis`),
            Effect.flatMap((result) =>
              Effect.sync(() => {
                const observation: TurnObservation = {
                  label,
                  turnId: result.turnId,
                  finalStatus: result.finalStatus,
                  answer: assistantAnswerFromItems(monitor.items, result.turnId),
                };
                observations.push(observation);
                if (result.turnId === null) {
                  throw new Error(`${label} turn never exposed an active turn id`);
                }
                if (result.finalStatus !== "ready") {
                  throw new Error(`${label} turn ended with status ${result.finalStatus}`);
                }
                if (!observation.answer?.toLowerCase().includes(expectedAnswer.toLowerCase())) {
                  throw new Error(
                    `${label} turn answer missing ${JSON.stringify(expectedAnswer)}: ${JSON.stringify(observation.answer)}`,
                  );
                }
              }),
            ),
          );
        };

        yield* paidTurn("seed", seedPrompt(codename), "noted");
        yield* paidTurn("small", SMALL_PROMPT, "ok");
        yield* paidTurn("seq", seqPrompt(SEQ_SIZE), `last number: ${String(SEQ_SIZE)}`);
      } else {
        monitor = yield* startThreadMonitor(handle, activeThreadId);
        monitorForEvidence = monitor;
        yield* Effect.sleep("500 millis");
        budget.charge();
        input.runner.noteTurn(provider);
        const resumeTurn = yield* runTurn(handle, monitor, {
          threadId: activeThreadId,
          text: recallPrompt(),
          provider: providerName,
          timeoutMs: TURN_TIMEOUT_MS,
          ...(modelSelection ? { modelSelection } : {}),
        }).pipe(Effect.timeout(`${String(TURN_TIMEOUT_MS)} millis`));
        resumeAnswer = assistantAnswerFromItems(monitor.items, resumeTurn.turnId);
        observations.push({
          label: "resume",
          turnId: resumeTurn.turnId,
          finalStatus: resumeTurn.finalStatus,
          answer: resumeAnswer,
        });
        if (resumeTurn.turnId === null) {
          throw new Error("resume turn never exposed an active turn id");
        }
        if (resumeTurn.finalStatus !== "ready") {
          throw new Error(`resume turn ended with status ${resumeTurn.finalStatus}`);
        }
      }

      threadId = activeThreadId;
      yield* stopSession(handle, activeThreadId).pipe(Effect.ignore);
      yield* Effect.sleep("1000 millis");
    }),
  );

  try {
    await Effect.runPromise(program as Effect.Effect<void, unknown, never>);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SmokeStepError(
      message,
      formatTurnEvidence(provider, monitorForEvidence, observations),
    );
  }
  if (!threadId) return undefined;
  return {
    threadId,
    resumeAnswer,
    turnEvidence: formatTurnEvidence(provider, monitorForEvidence, observations),
  };
}

async function runProviderFlow(input: {
  provider: SmokeProvider;
  origin: string;
  bearer: string;
  baseDir: string;
  lhcHome: string;
  workspaceRoot: string;
  runner: StepRunner;
  budget: TurnBudget;
}): Promise<void> {
  const { provider, origin, bearer, baseDir, lhcHome, workspaceRoot, runner, budget } = input;
  const codename = PROVIDER_CODENAMES[provider];
  const swapPath = SWAP_OP[provider];

  const turnCtx = await runner.run(
    `${provider}:turns`,
    `${provider} turns (seed + seq)`,
    () =>
      driveProviderTurns({
        provider,
        origin,
        bearer,
        workspaceRoot,
        runner,
        budget,
      }),
    { provider },
  );
  if (!turnCtx) return;

  const threadId = turnCtx.threadId;
  const turnsSent = 3;

  await runner.run(
    `${provider}:capture`,
    `${provider} capture verify`,
    async () => {
      const capture = await verifyCapture(lhcHome, threadId);
      const captureJudge = judgeCaptureCheck({
        lineageFound: capture.lineageFound,
        userPromptCount: capture.userPromptCount,
        turnsSent,
        duplicatedPromptCount: capture.duplicatedPromptCount,
        maxToolResultBytes: capture.maxToolResultBytes,
        turnsClosed: capture.turnsClosed,
        turnsOpen: capture.turnsOpen,
        minToolBytes: MIN_TOOL_BYTES,
      });
      if (!captureJudge.pass) {
        failStep(captureJudge.reasons.join("; "), capture);
      }
      if (capture.showCrossCheckMatches === false) {
        failStep("tool_result list vs show byte mismatch (preview truncation?)", capture);
      }
    },
    { provider },
  );

  let newSessionId: string | undefined;
  await runner.run(
    `${provider}:swap`,
    `${provider} ${swapPath}`,
    async () => {
      const swapResult = await lhcPost(
        origin,
        bearer,
        `/lhc/threads/${encodeURIComponent(threadId)}/${swapPath}`,
        {},
      );
      const receipt = receiptOf(swapResult);
      newSessionId = typeof receipt?.newSessionId === "string" ? receipt.newSessionId : undefined;
      const rebuiltPath =
        typeof receipt?.rebuiltPath === "string" ? receipt.rebuiltPath : undefined;
      const binding = readProviderRuntime(baseDir, threadId);
      const swapJudge = judgeSwapResult({
        httpStatus: swapResult.status,
        newSessionId,
        cursorSessionId: sessionIdFromCursor(binding?.resumeCursor, provider),
        rebuiltExists: rebuiltPath !== undefined && NodeFS.existsSync(rebuiltPath),
      });
      if (!swapJudge.pass) {
        failStep(swapJudge.reasons.join("; "), formatHttpEvidence(swapResult));
      }
    },
    { provider },
  );
  if (!newSessionId) return;

  await runner.run(
    `${provider}:resume`,
    `${provider} resume recall`,
    async () => {
      const resumeCtx = await driveProviderTurns({
        provider,
        origin,
        bearer,
        workspaceRoot,
        runner,
        budget,
        threadId,
      });
      const bindingAfter = readProviderRuntime(baseDir, threadId);
      const resumeJudge = judgeResumeResult({
        answer: resumeCtx?.resumeAnswer ?? null,
        codename,
        cursorSessionId: sessionIdFromCursor(bindingAfter?.resumeCursor, provider),
        expectedSessionId: newSessionId,
      });
      if (!resumeJudge.pass) {
        failStep(resumeJudge.reasons.join("; "), {
          answer: resumeCtx?.resumeAnswer ?? null,
          expectedCodename: codename,
          expectedSessionId: newSessionId,
          bindingAfter,
          turn: resumeCtx?.turnEvidence ?? "resume turn did not return context",
        });
      }
    },
    { provider },
  );

  await runner.run(
    `${provider}:status`,
    `${provider} /lhc/status + derivations`,
    async () => {
      const status = await lhcGet(origin, bearer, "/lhc/status");
      const statusBody = status.body;
      const threadListed =
        isRecord(statusBody) &&
        isRecord(statusBody.value) &&
        Array.isArray((statusBody.value as { threads?: unknown }).threads) &&
        ((statusBody.value as { threads: Array<{ t3ThreadId?: string }> }).threads ?? []).some(
          (t) => t.t3ThreadId === threadId,
        );
      if (!threadListed) {
        failStep(`thread ${threadId} missing from /lhc/status`, formatHttpEvidence(status));
      }
      await waitDerivationsOk(origin, bearer, threadId);
    },
    { provider },
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function ensureProviderSkips(runner: StepRunner, provider: SmokeProvider, skip: boolean): void {
  if (!skip) return;
  const prefix = `${provider}:`;
  if (runner.steps.some((s) => s.id.startsWith(prefix))) return;
  runner.skip(`${provider}:turns`, `${provider} turns (seed + seq)`, provider);
  runner.skip(`${provider}:capture`, `${provider} capture verify`, provider);
  runner.skip(`${provider}:swap`, `${provider} ${SWAP_OP[provider]}`, provider);
  runner.skip(`${provider}:resume`, `${provider} resume recall`, provider);
  runner.skip(`${provider}:status`, `${provider} /lhc/status + derivations`, provider);
}

function writeReport(input: SmokeReportInput): string {
  NodeFS.mkdirSync(REPORTS_DIR, { recursive: true });
  const reportPath = NodePath.join(REPORTS_DIR, `${formatReportTimestamp(input.generatedAt)}.md`);
  NodeFS.writeFileSync(reportPath, formatReportMarkdown(input));
  return reportPath;
}

function emitResults(runner: StepRunner, reportInput: SmokeReportInput, reportPath: string): void {
  console.log(formatReportTableStdout(reportInput));
  console.log(`\nreport: ${reportPath}`);
  const stderr = formatFailuresStderr(runner.steps);
  if (stderr) process.stderr.write(stderr);
  if (!reportInput.overallPass) process.exitCode = 1;
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { skipClaude, skipCodex, keep } = parseArgs(process.argv);
  const runner = new StepRunner();
  const budget = new TurnBudget();

  let baseDir: string | null = null;
  let lhcHome: string | null = null;
  let repoDir: string | null = null;
  let server: ServerHandle | null = null;
  let port = 0;
  let teardownPromise: Promise<void> | null = null;
  let reportPath = "";

  const teardown = (): Promise<void> => {
    teardownPromise ??= (async () => {
      await killServer(server);
      if (!keep) {
        removeDir(baseDir);
        removeDir(lhcHome);
        removeDir(repoDir);
      }
    })();
    return teardownPromise;
  };

  let receivedSignal: NodeJS.Signals | null = null;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (receivedSignal !== null) return;
    receivedSignal = signal;
    process.exitCode = 1;
    runner.steps.push({
      id: "signal",
      label: `received ${signal}`,
      status: "FAIL",
      durationMs: Date.now() - startedAt,
      detail: "run interrupted; teardown requested",
      evidence: `received ${signal}; scratch server teardown requested`,
    });
    void teardown();
  };
  const onSigint = (): void => onSignal("SIGINT");
  const onSigterm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-smoke-base-"));
    lhcHome = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-smoke-lhc-"));
    repoDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sync-smoke-repo-"));
    makeScratchRepo(repoDir);

    const pickedPort = await runner.run("setup:port", "pick free port", () => pickFreePort());
    if (pickedPort !== undefined) port = pickedPort;

    if (pickedPort !== undefined) {
      const booted = await runner.run("setup:boot", "boot scratch server", async () =>
        spawnServer(pickedPort, baseDir!, lhcHome!),
      );
      if (booted) server = booted;
    }

    let auth: { origin: string; bearer: string } | undefined;
    if (server) {
      auth = await runner.run(
        "setup:identity",
        "identity check + auth",
        () => waitForRuntime(baseDir!, lhcHome!, server!),
        { onFailEvidence: () => server!.logTail() },
      );
    }

    if (auth) {
      if (!skipClaude) {
        await runProviderFlow({
          provider: "claude",
          origin: auth.origin,
          bearer: auth.bearer,
          baseDir: baseDir!,
          lhcHome: lhcHome!,
          workspaceRoot: repoDir!,
          runner,
          budget,
        });
      }

      if (!skipCodex) {
        await runProviderFlow({
          provider: "codex",
          origin: auth.origin,
          bearer: auth.bearer,
          baseDir: baseDir!,
          lhcHome: lhcHome!,
          workspaceRoot: repoDir!,
          runner,
          budget,
        });
      }
    }

    ensureProviderSkips(runner, "claude", skipClaude);
    ensureProviderSkips(runner, "codex", skipCodex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runner.steps.push({
      id: "fatal",
      label: "unhandled error",
      status: "FAIL",
      durationMs: 0,
      detail: message,
      evidence: error instanceof Error ? (error.stack ?? message) : message,
    });
  } finally {
    await teardown();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);

    const generatedAt = new Date();
    const { claudeTurns, codexTurns } = runner.turnCounts();
    const reportInput: SmokeReportInput = {
      generatedAt,
      overallPass: runner.overallPass(),
      totalDurationMs: Date.now() - startedAt,
      steps: runner.steps,
      claudeTurns,
      codexTurns,
      port,
      baseDir: keep ? (baseDir ?? "(none)") : (baseDir ?? "(removed)"),
      lhcHome: keep ? (lhcHome ?? "(none)") : (lhcHome ?? "(removed)"),
      skipClaude,
      skipCodex,
    };
    reportPath = writeReport(reportInput);
    emitResults(runner, reportInput, reportPath);
  }
}

main().then(
  () => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 150);
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`sync-smoke fatal: ${message}\n`);
    process.exit(1);
  },
);
