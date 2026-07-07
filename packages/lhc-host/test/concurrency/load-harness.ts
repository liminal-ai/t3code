// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeSqlite from "node:sqlite";

import {
  deterministicText,
  initLhc,
  type HealthReport,
  type InferenceCallbacks,
  type InferenceResult,
  type Lhc,
  type MessageEventInput,
  type OpResult,
  type SdkConfig,
} from "lhc";

export interface ScenarioOptions {
  name: string;
  threadCount: number;
  turnsPerThread: number;
  baseDelayMs: number;
  jitterMs: number;
  failureRate: number;
  retry: NonNullable<SdkConfig["retry"]>;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  realInference: boolean;
  cleanup: boolean;
}

export interface ThreadRunSummary {
  threadIndex: number;
  threadId: string;
  filePath: string;
  drainLatenciesMs: number[];
  finalDrainLatencyMs: number;
  eventCount: number;
  messageCount: number;
  closedTurnCount: number;
  openTurnCount: number;
  health: HealthCounts;
  schedulerPasses: number;
}

export interface HealthCounts {
  ready: number;
  pending: number;
  retrying: number;
  failed: number;
  blocked: number;
  queueQueued: number;
  queueClaimed: number;
  failures: number;
}

export interface ScenarioSummary {
  name: string;
  options: ScenarioOptions;
  storageDir: string;
  totalEventsSent: number;
  totalMessagesExpected: number;
  wallMs: number;
  drainLatencyMs: MetricSummary;
  oldestQueuedStalenessMs: number;
  eventLoopMaxLagMs: number;
  inferenceCalls: number;
  inferenceFailuresInjected: number;
  inferenceMaxConcurrent: number;
  threads: ThreadRunSummary[];
  aggregateHealth: HealthCounts;
}

export interface MetricSummary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
  avg: number;
}

interface TempStore {
  dir: string;
  registryPath: string;
  cleanup: () => void;
}

interface InferenceStats {
  calls: number;
  failuresInjected: number;
  active: number;
  maxActive: number;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseRate(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export function scenarioOptions(overrides: Partial<ScenarioOptions> = {}): ScenarioOptions {
  return {
    name: overrides.name ?? "lhc-concurrency",
    threadCount: overrides.threadCount ?? parsePositiveInt("LHC_LOAD_THREADS", 10),
    turnsPerThread: overrides.turnsPerThread ?? parsePositiveInt("LHC_LOAD_TURNS", 3),
    baseDelayMs: overrides.baseDelayMs ?? parseNonNegativeInt("LHC_LOAD_DELAY_BASE_MS", 80),
    jitterMs: overrides.jitterMs ?? parseNonNegativeInt("LHC_LOAD_DELAY_JITTER_MS", 120),
    failureRate: overrides.failureRate ?? parseRate("LHC_LOAD_FAILURE_RATE", 0),
    retry: overrides.retry ?? {
      budget: parsePositiveInt("LHC_LOAD_RETRY_BUDGET", 5),
      backoffBaseMs: parseNonNegativeInt("LHC_LOAD_BACKOFF_BASE_MS", 25),
      backoffCapMs: parseNonNegativeInt("LHC_LOAD_BACKOFF_CAP_MS", 100),
    },
    pollIntervalMs: overrides.pollIntervalMs ?? parsePositiveInt("LHC_LOAD_POLL_INTERVAL_MS", 25),
    heartbeatIntervalMs:
      overrides.heartbeatIntervalMs ?? parsePositiveInt("LHC_LOAD_HEARTBEAT_MS", 50),
    realInference: overrides.realInference ?? false,
    cleanup: overrides.cleanup ?? process.env.LHC_LOAD_KEEP_TMP !== "1",
  };
}

function tempStore(): TempStore {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-concurrency-"));
  return {
    dir,
    registryPath: NodePath.join(dir, "registry.sqlite"),
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

function assertOk<T>(result: OpResult<T>, label: string): T {
  if (!result.ok) {
    throw new Error(`${label}: ${result.error.code}: ${result.error.reason}`);
  }
  return result.value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hashText(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function jitterFor(key: string, jitterMs: number): number {
  if (jitterMs <= 0) return 0;
  return hashText(key) % (jitterMs + 1);
}

function shouldFailFirstAttempt(
  key: string,
  failureRate: number,
  uniqueCallsSeen: number,
): boolean {
  if (failureRate <= 0) return false;
  if (uniqueCallsSeen === 1) return true;
  const bucket = hashText(key) / 0xffffffff;
  return bucket < failureRate;
}

function recordStart(stats: InferenceStats): void {
  stats.calls += 1;
  stats.active += 1;
  stats.maxActive = Math.max(stats.maxActive, stats.active);
}

function recordEnd(stats: InferenceStats): void {
  stats.active -= 1;
}

function createSimulatedInferenceCallbacks(
  options: Pick<ScenarioOptions, "baseDelayMs" | "jitterMs" | "failureRate">,
  stats: InferenceStats,
): InferenceCallbacks {
  const attemptsByKey = new Map<string, number>();

  async function run(
    op: "smoothPrompt" | "summarizeToolResult" | "compressDetailedTurn" | "summarizeChunkBrief",
    input: unknown,
    sourceText: string,
  ): Promise<InferenceResult> {
    const key = `${op}:${JSON.stringify(input)}`;
    const attempt = (attemptsByKey.get(key) ?? 0) + 1;
    attemptsByKey.set(key, attempt);
    recordStart(stats);
    try {
      await sleep(options.baseDelayMs + jitterFor(`${key}:${String(attempt)}`, options.jitterMs));
      if (attempt === 1 && shouldFailFirstAttempt(key, options.failureRate, attemptsByKey.size)) {
        stats.failuresInjected += 1;
        return {
          ok: false,
          retryable: true,
          reason: `scripted retryable failure for ${op}`,
        };
      }
      return { ok: true, text: deterministicText(op, input, sourceText) };
    } finally {
      recordEnd(stats);
    }
  }

  return {
    smoothPrompt: (input) => run("smoothPrompt", input, input.text),
    summarizeToolResult: (input) => run("summarizeToolResult", input, input.content),
    compressDetailedTurn: (input) => run("compressDetailedTurn", input, input.dialogueText),
    summarizeChunkBrief: (input) => run("summarizeChunkBrief", input, input.text),
  };
}

function excerpt(text: string, max = 500): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}...`;
}

function claudeArgs(): string[] {
  const model = process.env.LHC_LOAD_CLAUDE_MODEL ?? "haiku";
  return model.trim() === "" ? ["-p"] : ["-p", "--model", model];
}

function realInferenceTimeoutMs(): number {
  return parsePositiveInt("LHC_LOAD_REAL_TIMEOUT_MS", 180_000);
}

async function claudePrompt(prompt: string, timeoutMs: number): Promise<InferenceResult> {
  return new Promise((resolve) => {
    const child = NodeChildProcess.spawn("claude", claudeArgs(), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        ok: false,
        retryable: true,
        reason: `claude -p timed out after ${String(timeoutMs)}ms`,
      });
    }, timeoutMs);

    function finish(result: InferenceResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    }

    child.on("error", (cause) => {
      finish({ ok: false, retryable: false, reason: excerpt(cause.message) });
    });
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) finish({ ok: true, text: stdout });
      else
        finish({
          ok: false,
          retryable: false,
          reason: excerpt(stderr || `claude exited ${String(code)}`),
        });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

function createClaudeInferenceCallbacks(stats: InferenceStats): InferenceCallbacks {
  async function run(label: string, body: string): Promise<InferenceResult> {
    recordStart(stats);
    try {
      return await claudePrompt(
        `Return concise derived context for ${label}.\n\n${body}`,
        realInferenceTimeoutMs(),
      );
    } finally {
      recordEnd(stats);
    }
  }

  return {
    smoothPrompt: (input) => run("prompt smoothing", input.text),
    summarizeToolResult: (input) => run("tool result summary", input.content),
    compressDetailedTurn: (input) => run("turn compression", input.dialogueText),
    summarizeChunkBrief: (input) => run("chunk brief", input.text),
  };
}

function makeTurnBatch(threadIndex: number, turnIndex: number): MessageEventInput[] {
  const prefix = `thread-${String(threadIndex)}-turn-${String(turnIndex)}`;
  const toolCallId = `${prefix}-call`;
  return [
    {
      eventKind: "user_prompt",
      idempotencyKey: `${prefix}-user`,
      actor: "load-harness",
      harness: "lhc-host-concurrency",
      payload: { text: `${prefix}-prompt: inspect the project state and prepare a small change.` },
    },
    {
      eventKind: "assistant_thinking",
      idempotencyKey: `${prefix}-thinking`,
      actor: "load-harness",
      harness: "lhc-host-concurrency",
      payload: { text: `${prefix}-thinking: selecting files, commands, and verification path.` },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: `${prefix}-assistant`,
      actor: "load-harness",
      harness: "lhc-host-concurrency",
      payload: { text: `${prefix}-assistant: I will gather context and keep the change scoped.` },
    },
    {
      eventKind: "tool_call",
      idempotencyKey: `${prefix}-tool-call`,
      actor: "load-harness",
      harness: "lhc-host-concurrency",
      payload: {
        toolCallId,
        toolName: "shell",
        arguments: { command: `rg ${prefix} packages docs`, cwd: `/tmp/${prefix}` },
      },
    },
    {
      eventKind: "tool_result",
      idempotencyKey: `${prefix}-tool-result`,
      actor: "load-harness",
      harness: "lhc-host-concurrency",
      payload: {
        toolCallId,
        content: `${prefix}-tool-result: no matches; command exited 1 after scanning 42 files.`,
        isError: false,
      },
    },
    {
      eventKind: "turn_end",
      idempotencyKey: `${prefix}-turn-end`,
      actor: "load-harness",
      harness: "lhc-host-concurrency",
      payload: {},
    },
  ];
}

class Heartbeat {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private expected = 0;
  maxLagMs = 0;

  private readonly intervalMs: number;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.expected = NodePerfHooks.performance.now() + this.intervalMs;
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    const now = NodePerfHooks.performance.now();
    this.maxLagMs = Math.max(this.maxLagMs, Math.max(0, now - this.expected));
    this.expected = now + this.intervalMs;
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }
}

class QueueSampler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly startedAt = Date.now();
  maxOldestStalenessMs = 0;
  private readonly files: () => string[];
  private readonly intervalMs: number;

  constructor(files: () => string[], intervalMs: number) {
    this.files = files;
    this.intervalMs = intervalMs;
  }

  start(): void {
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.sample();
  }

  private tick(): void {
    this.sample();
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  private sample(): void {
    const now = Date.now();
    for (const filePath of this.files()) {
      const queuedAt = oldestLiveQueuedAt(filePath);
      if (queuedAt === undefined) continue;
      const parsed = Date.parse(queuedAt);
      if (Number.isFinite(parsed)) {
        this.maxOldestStalenessMs = Math.max(this.maxOldestStalenessMs, now - parsed);
      } else {
        this.maxOldestStalenessMs = Math.max(this.maxOldestStalenessMs, now - this.startedAt);
      }
    }
  }
}

function oldestLiveQueuedAt(filePath: string): string | undefined {
  if (!NodeFS.existsSync(filePath)) return undefined;
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(filePath, { readOnly: true });
    const row = db
      .prepare(
        `SELECT queued_at
         FROM work_item
         WHERE status IN ('queued', 'claimed')
         ORDER BY rowid
         LIMIT 1`,
      )
      .get() as { queued_at: string } | undefined;
    return row?.queued_at;
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function metricSummary(values: readonly number[]): MetricSummary {
  if (values.length === 0) return { count: 0, min: 0, p50: 0, p95: 0, max: 0, avg: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1]!,
    avg: sum / sorted.length,
  };
}

function emptyHealth(): HealthCounts {
  return {
    ready: 0,
    pending: 0,
    retrying: 0,
    failed: 0,
    blocked: 0,
    queueQueued: 0,
    queueClaimed: 0,
    failures: 0,
  };
}

function healthCounts(report: HealthReport): HealthCounts {
  const counts = emptyHealth();
  for (const owner of report.owners) {
    counts.ready += owner.counts.ready;
    counts.pending += owner.counts.pending;
    counts.retrying += owner.counts.retrying;
    counts.failed += owner.counts.failed;
    counts.blocked += owner.counts.blocked;
  }
  counts.queueQueued = report.queue.queued;
  counts.queueClaimed = report.queue.claimed;
  counts.failures = report.failures.length;
  return counts;
}

function addHealth(target: HealthCounts, source: HealthCounts): void {
  target.ready += source.ready;
  target.pending += source.pending;
  target.retrying += source.retrying;
  target.failed += source.failed;
  target.blocked += source.blocked;
  target.queueQueued += source.queueQueued;
  target.queueClaimed += source.queueClaimed;
  target.failures += source.failures;
}

async function driveThread(
  sdk: Lhc,
  threadIndex: number,
  filePath: string,
  turnsPerThread: number,
): Promise<{ drainLatenciesMs: number[]; finalDrainLatencyMs: number }> {
  const settled: Array<Promise<number>> = [];
  for (let turnIndex = 0; turnIndex < turnsPerThread; turnIndex += 1) {
    const batch = makeTurnBatch(threadIndex, turnIndex);
    const firstHalf = await sdk.intakeStream.messageEvents({ filePath }, batch.slice(0, 3));
    assertOk(
      firstHalf,
      `thread ${String(threadIndex)} turn ${String(turnIndex)} intake first half`,
    );
    await sleep(jitterFor(`${String(threadIndex)}:${String(turnIndex)}:gap`, 8));
    const secondHalf = await sdk.intakeStream.messageEvents({ filePath }, batch.slice(3));
    assertOk(
      secondHalf,
      `thread ${String(threadIndex)} turn ${String(turnIndex)} intake second half`,
    );

    const turnEndAt = NodePerfHooks.performance.now();
    settled.push(
      sdk.drainSettled({ filePath }).then(() => NodePerfHooks.performance.now() - turnEndAt),
    );
    await sleep(jitterFor(`${String(threadIndex)}:${String(turnIndex)}:next`, 12));
  }
  const finalStartedAt = NodePerfHooks.performance.now();
  await sdk.drainSettled({ filePath });
  const finalDrainLatencyMs = NodePerfHooks.performance.now() - finalStartedAt;
  return { drainLatenciesMs: await Promise.all(settled), finalDrainLatencyMs };
}

async function verifyThread(
  sdk: Lhc,
  threadIndex: number,
  threadId: string,
  filePath: string,
  turnsPerThread: number,
  threadCount: number,
  drainLatenciesMs: number[],
  finalDrainLatencyMs: number,
): Promise<ThreadRunSummary> {
  const events = assertOk(
    await sdk.intakeStream.listEvents({ filePath }),
    `thread ${String(threadIndex)} events`,
  );
  const messages = assertOk(
    await sdk.messages.list({ filePath }),
    `thread ${String(threadIndex)} messages`,
  );
  const turns = assertOk(
    await sdk.turns.listTurns({ filePath }),
    `thread ${String(threadIndex)} turns`,
  );
  const health = healthCounts(
    assertOk(await sdk.inspect.health({ filePath }), `thread ${String(threadIndex)} health`),
  );

  const expectedEvents = turnsPerThread * 6;
  const expectedMessages = turnsPerThread * 5;
  if (events.length !== expectedEvents) {
    throw new Error(
      `thread ${String(threadIndex)} expected ${String(expectedEvents)} events, saw ${String(events.length)}`,
    );
  }
  if (messages.length !== expectedMessages) {
    throw new Error(
      `thread ${String(threadIndex)} expected ${String(expectedMessages)} messages, saw ${String(messages.length)}`,
    );
  }
  const closedTurnCount = turns.filter((turn) => turn.status === "closed").length;
  const openTurnCount = turns.filter((turn) => turn.status === "open").length;
  if (closedTurnCount !== turnsPerThread || openTurnCount !== 1) {
    throw new Error(
      `thread ${String(threadIndex)} expected ${String(turnsPerThread)} closed and 1 open turn, saw ${String(
        closedTurnCount,
      )} closed and ${String(openTurnCount)} open`,
    );
  }

  const serializedMessages = JSON.stringify(messages);
  for (let turnIndex = 0; turnIndex < turnsPerThread; turnIndex += 1) {
    const ownMarker = `thread-${String(threadIndex)}-turn-${String(turnIndex)}`;
    if (!serializedMessages.includes(ownMarker)) {
      throw new Error(`thread ${String(threadIndex)} is missing marker ${ownMarker}`);
    }
  }
  if (threadCount > 1) {
    const neighborMarker = `thread-${String((threadIndex + 1) % threadCount)}-turn-0`;
    if (serializedMessages.includes(neighborMarker)) {
      throw new Error(
        `thread ${String(threadIndex)} contains cross-thread marker ${neighborMarker}`,
      );
    }
  }
  if (
    health.pending !== 0 ||
    health.retrying !== 0 ||
    health.queueQueued !== 0 ||
    health.queueClaimed !== 0
  ) {
    throw new Error(`thread ${String(threadIndex)} did not quiesce: ${JSON.stringify(health)}`);
  }

  return {
    threadIndex,
    threadId,
    filePath,
    drainLatenciesMs,
    finalDrainLatencyMs,
    eventCount: events.length,
    messageCount: messages.length,
    closedTurnCount,
    openTurnCount,
    health,
    schedulerPasses: sdk.scheduler.testPassCount(threadId),
  };
}

export async function runConcurrencyScenario(
  input: Partial<ScenarioOptions> = {},
): Promise<ScenarioSummary> {
  const options = scenarioOptions(input);
  const store = tempStore();
  const stats: InferenceStats = { calls: 0, failuresInjected: 0, active: 0, maxActive: 0 };
  const filePaths: string[] = [];
  const heartbeat = new Heartbeat(options.heartbeatIntervalMs);
  const sampler = new QueueSampler(() => filePaths, options.pollIntervalMs);
  const startedAt = NodePerfHooks.performance.now();

  const callbacks = options.realInference
    ? createClaudeInferenceCallbacks(stats)
    : createSimulatedInferenceCallbacks(options, stats);
  const sdk = initLhc({
    mode: "background",
    inferenceCallbacks: callbacks,
    retry: options.retry,
    toolResult: { smallTierTokens: 1, smallTargetRatio: 0.15, midTargetRatio: 0.04 },
    guards: { detailedTurnCompression: { tinyTurnTokens: 10 } },
  });

  try {
    heartbeat.start();
    sampler.start();

    const threads = await Promise.all(
      Array.from({ length: options.threadCount }, async (_, threadIndex) => {
        const filePath = NodePath.join(store.dir, `thread-${String(threadIndex)}.sqlite`);
        const created = assertOk(
          await sdk.threads.newThread({
            filePath,
            registryPath: store.registryPath,
            title: `concurrency ${String(threadIndex)}`,
          }),
          `thread ${String(threadIndex)} create`,
        );
        filePaths.push(created.filePath);
        return { threadIndex, threadId: created.threadId, filePath: created.filePath };
      }),
    );

    const driven = await Promise.all(
      threads.map(async (thread) => ({
        ...thread,
        ...(await driveThread(sdk, thread.threadIndex, thread.filePath, options.turnsPerThread)),
      })),
    );

    const verified = await Promise.all(
      driven.map((thread) =>
        verifyThread(
          sdk,
          thread.threadIndex,
          thread.threadId,
          thread.filePath,
          options.turnsPerThread,
          options.threadCount,
          thread.drainLatenciesMs,
          thread.finalDrainLatencyMs,
        ),
      ),
    );

    const aggregateHealth = emptyHealth();
    const allLatencies: number[] = [];
    for (const thread of verified) {
      addHealth(aggregateHealth, thread.health);
      allLatencies.push(...thread.drainLatenciesMs);
    }

    return {
      name: options.name,
      options,
      storageDir: store.dir,
      totalEventsSent: options.threadCount * options.turnsPerThread * 6,
      totalMessagesExpected: options.threadCount * options.turnsPerThread * 5,
      wallMs: NodePerfHooks.performance.now() - startedAt,
      drainLatencyMs: metricSummary(allLatencies),
      oldestQueuedStalenessMs: sampler.maxOldestStalenessMs,
      eventLoopMaxLagMs: heartbeat.maxLagMs,
      inferenceCalls: stats.calls,
      inferenceFailuresInjected: stats.failuresInjected,
      inferenceMaxConcurrent: stats.maxActive,
      threads: verified.sort((a, b) => a.threadIndex - b.threadIndex),
      aggregateHealth,
    };
  } finally {
    sampler.stop();
    heartbeat.stop();
    if (options.cleanup) store.cleanup();
  }
}

export function formatScenarioSummary(summary: ScenarioSummary): string {
  return JSON.stringify(
    {
      name: summary.name,
      scale: {
        threads: summary.options.threadCount,
        turnsPerThread: summary.options.turnsPerThread,
        baseDelayMs: summary.options.baseDelayMs,
        jitterMs: summary.options.jitterMs,
        failureRate: summary.options.failureRate,
      },
      wallMs: Math.round(summary.wallMs),
      drainLatencyMs: roundMetric(summary.drainLatencyMs),
      oldestQueuedStalenessMs: Math.round(summary.oldestQueuedStalenessMs),
      eventLoopMaxLagMs: Math.round(summary.eventLoopMaxLagMs),
      inferenceCalls: summary.inferenceCalls,
      inferenceFailuresInjected: summary.inferenceFailuresInjected,
      inferenceMaxConcurrent: summary.inferenceMaxConcurrent,
      aggregateHealth: summary.aggregateHealth,
      schedulerPasses: summary.threads.map((thread) => thread.schedulerPasses),
    },
    null,
    2,
  );
}

function roundMetric(metric: MetricSummary): MetricSummary {
  return {
    count: metric.count,
    min: Math.round(metric.min),
    p50: Math.round(metric.p50),
    p95: Math.round(metric.p95),
    max: Math.round(metric.max),
    avg: Math.round(metric.avg),
  };
}
