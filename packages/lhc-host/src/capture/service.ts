// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
import { initLhc, type Lhc, type MessageEventInput, type SdkConfig } from "lhc";

import { captureSdkConfig, isCaptureDisabled } from "../config.ts";
import { killAllInferenceChildren } from "../inference/claude-cli.ts";
import {
  createCaptureStats,
  createTurnAccumulator,
  mapProviderRuntimeEvent,
  recordCaptureMapResult,
  userPromptEvent,
  type CaptureStats,
  type TurnAccumulatorState,
} from "../intake/index.ts";
import { createLineageStore, type LineageStore, type LineageStoreDeps } from "../lineage.ts";
import {
  captureThreadRef,
  ensureStateDirs,
  lhcHome,
  lineageDbPath,
  newThreadFilePath,
  registryPath,
} from "../paths.ts";

/** Standing decision: LHC captures Claude Code and Codex only in this pass. */
export const CAPTURED_DRIVER_KINDS: readonly string[] = ["claudeAgent", "codex"];

export const DEFAULT_DRAIN_SETTLED_CAP_MS = 30_000;
export const DRAIN_NOT_SETTLED_MESSAGE =
  "t3code-lhc: drain not settled at shutdown, derivation work remains pending";

/**
 * The per-thread intake queue is unbounded ON PURPOSE: capture is
 * durability-first, so a temporarily slow intake must buffer rather than drop
 * provider events. The high-watermark warning below is the pressure-relief
 * valve — it surfaces a stalled thread without sacrificing durability.
 */
const PENDING_WARN_THRESHOLD = 10_000;
/** Idle thread-state entries are swept lazily (no timers) after this long. */
const IDLE_EVICT_MS = 10 * 60 * 1000;

export interface TurnStartedInfo {
  threadId: string;
  turnId: string;
  prompt: string;
  /** Driver kind of the routed adapter; used to scope injection to captured providers. */
  provider: string;
}

export interface ThreadIntakeStats {
  batches: number;
  recorded: number;
  deduped: number;
  failedBatches: number;
  intakeThrew: number;
  lineageFailures: number;
  promptsInjected: number;
  emptyPromptsSkipped: number;
}

export interface ThreadCaptureStats {
  t3ThreadId: string;
  lhcThreadId: string | null;
  providerKind: string;
  /** Currently queued + in-flight jobs for this thread. */
  pending: number;
  /** Max pending depth ever observed for this thread. */
  pendingHigh: number;
  mapper: CaptureStats;
  intake: ThreadIntakeStats;
}

export interface CaptureServiceStats {
  enabled: boolean;
  mode: "background" | "manual" | "disabled";
  eventsSeen: number;
  eventsIgnored: number;
  global: { mapper: CaptureStats; intake: ThreadIntakeStats; pendingHigh: number };
  threads: ThreadCaptureStats[];
}

export interface CaptureServiceOptions {
  home?: string;
  noInference?: boolean;
  disabled?: boolean;
  capturedProviders?: readonly string[];
  drainSettledCapMs?: number;
  log?: (message: string) => void;
  logError?: (message: string) => void;
  /** Test hook: substitute SDK construction. */
  initSdkFn?: (config: SdkConfig) => Lhc;
  /** Test hook: substitute lineage internals. */
  lineageDeps?: LineageStoreDeps;
  /** Test hook: substitute the mapper (e.g. to inject contract-violating batches). */
  mapFn?: typeof mapProviderRuntimeEvent;
}

export interface CaptureService {
  readonly enabled: boolean;
  readonly mode: "background" | "manual" | "disabled";
  /** SDK handle for later control-surface slices; undefined when disabled. */
  readonly sdk: Lhc | undefined;
  /** Route one raw ProviderRuntimeEvent; never throws (fail-soft by contract). */
  handleEvent(event: unknown): void;
  /** Host-side user-prompt injection at the sendTurn choke point (impl-log ruling). */
  noteTurnStarted(info: TurnStartedInfo): void;
  /** LHC thread ref recorded for a t3 thread, once its first event landed. */
  threadRef(t3ThreadId: string): { threadId: string; registryPath: string } | undefined;
  /** Durable lineage lookup, including threads whose in-memory capture state was evicted. */
  lookupThread(t3ThreadId: string): { threadId: string; registryPath: string } | undefined;
  /** Durable lineage listing for the control surface. */
  listCapturedThreads(): Array<{
    t3ThreadId: string;
    lhcThreadId: string;
    providerKind: string;
    createdAt: string;
  }>;
  stats(): CaptureServiceStats;
  /** Register a cleanup callback run once during stop() (e.g. observer disposer). */
  onStop(hook: () => void): void;
  /** Await all currently queued per-thread work (test helper; not drainSettled). */
  settle(): Promise<void>;
  /** Idempotent: stop accepting, flush queues + drain-settle under one cap, then kill children. */
  stop(): Promise<void>;
}

interface ThreadState {
  t3ThreadId: string;
  queue: Promise<void>;
  providerKind: string;
  lhcThreadId: string | null;
  ref: { threadId: string; registryPath: string } | null;
  accumulator: TurnAccumulatorState;
  mapper: CaptureStats;
  intake: ThreadIntakeStats;
  pending: number;
  pendingHigh: number;
  lastActivityMs: number;
  warnedWatermark: boolean;
}

function emptyIntakeStats(): ThreadIntakeStats {
  return {
    batches: 0,
    recorded: 0,
    deduped: 0,
    failedBatches: 0,
    intakeThrew: 0,
    lineageFailures: 0,
    promptsInjected: 0,
    emptyPromptsSkipped: 0,
  };
}

function addMapperStats(dst: CaptureStats, src: CaptureStats): void {
  dst.linesSeen += src.linesSeen;
  dst.eventsOut += src.eventsOut;
  dst.malformed += src.malformed;
  for (const [key, count] of Object.entries(src.skips)) {
    dst.skips[key] = (dst.skips[key] ?? 0) + count;
  }
}

function addIntakeStats(dst: ThreadIntakeStats, src: ThreadIntakeStats): void {
  for (const key of Object.keys(dst) as Array<keyof ThreadIntakeStats>) {
    dst[key] += src[key];
  }
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function disabledService(): CaptureService {
  return {
    enabled: false,
    mode: "disabled",
    sdk: undefined,
    handleEvent: () => {},
    noteTurnStarted: () => {},
    threadRef: () => undefined,
    lookupThread: () => undefined,
    listCapturedThreads: () => [],
    stats: () => ({
      enabled: false,
      mode: "disabled",
      eventsSeen: 0,
      eventsIgnored: 0,
      global: { mapper: createCaptureStats(), intake: emptyIntakeStats(), pendingHigh: 0 },
      threads: [],
    }),
    onStop: () => {},
    settle: async () => {},
    stop: async () => {},
  };
}

/**
 * Long-lived capture service: one SDK instance, per-thread serialized intake
 * workers keyed by t3 threadId (hard requirement — one t3 thread ↔ one LHC
 * thread ↔ one SQLite file; cross-thread concurrency is fine). Capture must
 * NEVER propagate errors into the server's event path: every worker body is
 * fail-soft, logging through `sdk.logging` and counting into stats.
 */
export function startCaptureService(options: CaptureServiceOptions = {}): CaptureService {
  if (options.disabled === true || isCaptureDisabled()) return disabledService();

  const home = options.home ?? lhcHome();
  ensureStateDirs(home);

  const now = (): number => Date.now();
  const log = options.log ?? (() => {});
  const logError =
    options.logError ??
    ((message: string) => {
      console.error(message);
    });
  const mapFn = options.mapFn ?? mapProviderRuntimeEvent;
  const capturedProviders = new Set(options.capturedProviders ?? CAPTURED_DRIVER_KINDS);
  const drainSettledCapMs = options.drainSettledCapMs ?? DEFAULT_DRAIN_SETTLED_CAP_MS;

  const sdkConfig = captureSdkConfig(
    options.noInference === undefined ? {} : { noInference: options.noInference },
  );
  const sdk = (options.initSdkFn ?? initLhc)(sdkConfig);
  const registry = registryPath(home);
  const lineage: LineageStore = createLineageStore(
    { dbPath: lineageDbPath(home), registryPath: registry },
    // Thread files live under THIS home's threads/ dir, not the env default.
    { threadFilePathFn: () => newThreadFilePath(home), ...options.lineageDeps },
  );

  const threadStates = new Map<string, ThreadState>();
  // Stats for lazily-evicted idle threads, folded in so global totals stay honest.
  const evictedMapper = createCaptureStats();
  const evictedIntake = emptyIntakeStats();
  let evictedPendingHigh = 0;
  const stopHooks: Array<() => void> = [];
  let eventsSeen = 0;
  let eventsIgnored = 0;
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  function threadState(t3ThreadId: string, providerKind: string): ThreadState {
    let state = threadStates.get(t3ThreadId);
    if (state === undefined) {
      state = {
        t3ThreadId,
        queue: Promise.resolve(),
        providerKind,
        lhcThreadId: null,
        ref: null,
        accumulator: createTurnAccumulator(t3ThreadId),
        mapper: createCaptureStats(),
        intake: emptyIntakeStats(),
        pending: 0,
        pendingHigh: 0,
        lastActivityMs: now(),
        warnedWatermark: false,
      };
      threadStates.set(t3ThreadId, state);
    }
    return state;
  }

  // Lazy eviction (no timers): drop thread-state entries whose queue has been
  // empty and idle past the cutoff. Their stats are folded into the evicted
  // accumulators first; a later event for the same t3 thread rebuilds fresh
  // state and re-resolves the same LHC thread via lineage (idempotent).
  function sweepIdle(exceptId: string): void {
    const cutoff = now() - IDLE_EVICT_MS;
    for (const [id, state] of threadStates) {
      if (id === exceptId) continue;
      if (state.pending === 0 && state.lastActivityMs < cutoff) {
        addMapperStats(evictedMapper, state.mapper);
        addIntakeStats(evictedIntake, state.intake);
        evictedPendingHigh = Math.max(evictedPendingHigh, state.pendingHigh);
        threadStates.delete(id);
      }
    }
  }

  function warnHighWatermark(state: ThreadState): void {
    const message = `t3code-lhc: thread ${state.t3ThreadId} intake backlog ${String(state.pending)} (unbounded queue, durability-first) — investigate a stalled intake`;
    logError(message);
    // Fail-soft: capture must never throw into the event path.
    if (state.ref !== null) {
      void sdk.logging.write(state.ref, { level: "warning", message }).catch(() => {});
    }
  }

  function enqueue(state: ThreadState, job: () => Promise<void>): void {
    sweepIdle(state.t3ThreadId);
    state.pending += 1;
    if (state.pending > state.pendingHigh) state.pendingHigh = state.pending;
    state.lastActivityMs = now();
    if (state.pending >= PENDING_WARN_THRESHOLD && !state.warnedWatermark) {
      state.warnedWatermark = true;
      warnHighWatermark(state);
    }
    // Per-thread FIFO: jobs chain on the thread's queue; the job body is
    // fail-soft, and this catch is a belt against defects so one bad job can
    // never wedge the thread's queue. The finally keeps pending honest whether
    // the job resolved or rejected.
    state.queue = state.queue
      .then(job)
      .catch((cause) => {
        logError(`t3code-lhc worker defect: ${detail(cause)}`);
      })
      .finally(() => {
        state.pending -= 1;
        state.lastActivityMs = now();
        if (state.pending === 0) state.warnedWatermark = false;
      });
  }

  async function resolveRef(t3ThreadId: string, state: ThreadState): Promise<boolean> {
    if (state.ref !== null) return true;
    try {
      const resolved = await lineage.getOrCreate(t3ThreadId, {
        providerKind: state.providerKind,
        title: `t3code ${state.providerKind} ${t3ThreadId}`,
      });
      if (!resolved.ok) {
        state.intake.lineageFailures += 1;
        logError(
          `t3code-lhc lineage failed for ${t3ThreadId}: ${resolved.error.code} ${resolved.error.reason}`,
        );
        return false;
      }
      state.lhcThreadId = resolved.value.lhcThreadId;
      state.ref = captureThreadRef(resolved.value.lhcThreadId, registry);
      if (resolved.value.created) {
        log(`t3code-lhc: created LHC thread ${resolved.value.lhcThreadId} for t3 ${t3ThreadId}`);
      }
      return true;
    } catch (cause) {
      state.intake.lineageFailures += 1;
      logError(`t3code-lhc lineage threw for ${t3ThreadId}: ${detail(cause)}`);
      return false;
    }
  }

  async function sendBatch(
    t3ThreadId: string,
    state: ThreadState,
    events: readonly MessageEventInput[],
  ): Promise<void> {
    if (events.length === 0) return;
    if (!(await resolveRef(t3ThreadId, state)) || state.ref === null) return;
    state.intake.batches += 1;
    try {
      const result = await sdk.intakeStream.messageEvents(state.ref, events);
      if (!result.ok) {
        state.intake.failedBatches += 1;
        logError(
          `t3code-lhc intake rejected for ${t3ThreadId}: ${result.error.code} ${result.error.reason}`,
        );
        await sdk.logging
          .write(state.ref, {
            level: "error",
            message: `intake rejected: ${result.error.code}`,
            reason: result.error.reason,
          })
          .catch(() => {});
        return;
      }
      for (const entry of result.value.events) {
        if (entry.outcome === "recorded") state.intake.recorded += 1;
        else state.intake.deduped += 1;
      }
    } catch (cause) {
      state.intake.intakeThrew += 1;
      logError(`t3code-lhc intake threw for ${t3ThreadId}: ${detail(cause)}`);
    }
  }

  function aggregate(): { mapper: CaptureStats; intake: ThreadIntakeStats; pendingHigh: number } {
    const mapper = createCaptureStats();
    addMapperStats(mapper, evictedMapper);
    const intake = emptyIntakeStats();
    addIntakeStats(intake, evictedIntake);
    let pendingHigh = evictedPendingHigh;
    for (const state of threadStates.values()) {
      addMapperStats(mapper, state.mapper);
      addIntakeStats(intake, state.intake);
      pendingHigh = Math.max(pendingHigh, state.pendingHigh);
    }
    return { mapper, intake, pendingHigh };
  }

  async function settleQueues(): Promise<void> {
    // Two passes: a job finishing between snapshot and await may have been
    // followed by enqueues from the event stream while we were not stopped.
    for (let pass = 0; pass < 2; pass += 1) {
      await Promise.all([...threadStates.values()].map((state) => state.queue));
    }
  }

  async function drainAllSettled(): Promise<void> {
    const refs = [...threadStates.values()]
      .map((state) => state.ref)
      .filter((ref): ref is { threadId: string; registryPath: string } => ref !== null);
    if (refs.length === 0) return;
    await Promise.all(refs.map((ref) => sdk.drainSettled(ref)));
  }

  // Run the shutdown work under ONE total deadline. On timeout we log and
  // resolve (never reject) so the caller's finally — stop hooks + child kill —
  // always runs, even if an intake job is wedged forever.
  function runWithDeadline(work: () => Promise<void>, capMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        logError(DRAIN_NOT_SETTLED_MESSAGE);
        resolve();
      }, capMs);
      work().then(finish, (cause) => {
        logError(`t3code-lhc shutdown work failed: ${detail(cause)}`);
        finish();
      });
    });
  }

  return {
    enabled: true,
    mode: sdkConfig.mode,
    sdk,

    handleEvent(event: unknown): void {
      if (stopped) return;
      if (
        !isRecord(event) ||
        typeof event.threadId !== "string" ||
        typeof event.provider !== "string" ||
        !capturedProviders.has(event.provider)
      ) {
        eventsIgnored += 1;
        return;
      }
      eventsSeen += 1;
      const state = threadState(event.threadId, event.provider);
      const t3ThreadId = event.threadId;
      enqueue(state, async () => {
        const mapped = mapFn(event, { turnAccumulator: state.accumulator });
        recordCaptureMapResult(state.mapper, mapped);
        await sendBatch(t3ThreadId, state, mapped.events);
      });
    },

    noteTurnStarted(info: TurnStartedInfo): void {
      if (stopped) return;
      if (!capturedProviders.has(info.provider)) return;
      const state = threadState(info.threadId, info.provider);
      if (info.prompt.trim() === "") {
        state.intake.emptyPromptsSkipped += 1;
        return;
      }
      // Ordering relative to this turn's stream events is not guaranteed by
      // timing and does not need to be: LHC's turn machine lets a user_prompt
      // join an already-open empty turn, and a stream user_message with the
      // same turnId dedupes by key either way (impl-log ruling, 2026-07-07).
      enqueue(state, async () => {
        state.intake.promptsInjected += 1;
        await sendBatch(info.threadId, state, [
          userPromptEvent(info.threadId, info.turnId, info.prompt),
        ]);
      });
    },

    threadRef(t3ThreadId: string): { threadId: string; registryPath: string } | undefined {
      return threadStates.get(t3ThreadId)?.ref ?? undefined;
    },

    lookupThread(t3ThreadId: string): { threadId: string; registryPath: string } | undefined {
      const hotRef = threadStates.get(t3ThreadId)?.ref ?? undefined;
      if (hotRef !== undefined) return hotRef;
      const row = lineage.lookup(t3ThreadId);
      return row === undefined ? undefined : captureThreadRef(row.lhcThreadId, registry);
    },

    listCapturedThreads() {
      return lineage.list().map((row) => ({
        t3ThreadId: row.t3ThreadId,
        lhcThreadId: row.lhcThreadId,
        providerKind: row.providerKind,
        createdAt: row.createdAt,
      }));
    },

    stats(): CaptureServiceStats {
      return {
        enabled: true,
        mode: sdkConfig.mode,
        eventsSeen,
        eventsIgnored,
        global: aggregate(),
        threads: [...threadStates.entries()].map(([t3ThreadId, state]) => ({
          t3ThreadId,
          lhcThreadId: state.lhcThreadId,
          providerKind: state.providerKind,
          pending: state.pending,
          pendingHigh: state.pendingHigh,
          mapper: state.mapper,
          intake: state.intake,
        })),
      };
    },

    onStop(hook: () => void): void {
      stopHooks.push(hook);
    },

    async settle(): Promise<void> {
      await settleQueues();
    },

    stop(): Promise<void> {
      if (stopPromise === undefined) {
        stopPromise = (async () => {
          stopped = true;
          try {
            // Whole stop sequence (flush + drain-settle) under one total cap.
            await runWithDeadline(async () => {
              await settleQueues();
              // Manual-mode SDKs never schedule drains; skip the settle wait.
              if (sdkConfig.mode === "background") await drainAllSettled();
            }, drainSettledCapMs);
          } finally {
            // Nothing above can skip teardown: run stop hooks (observer
            // disposers) and kill inference children even on the timeout path.
            for (const hook of stopHooks) {
              try {
                hook();
              } catch (cause) {
                logError(`t3code-lhc stop hook failed: ${detail(cause)}`);
              }
            }
            killAllInferenceChildren();
          }
        })();
      }
      return stopPromise;
    },
  };
}
