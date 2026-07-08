// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type {
  HealthReport,
  InspectOverview,
  Lhc,
  MessageEventInput,
  OpResult,
  SessionThreadView,
  ViewCompactParams,
  ViewStatus,
} from "lhc";

import type { CaptureService, CaptureServiceStats } from "../capture/service.ts";

export type SwapOperation = "compact" | "prune";

export type SwapStep =
  | "resolve-lineage"
  | "busy-check"
  | "read-binding"
  | "lhc-operation"
  | "render-view"
  | "quiesce"
  | "resolve-paths"
  | "rebuild"
  | "preflip-validate"
  | "cursor-flip"
  | "runtime-note"
  | "receipt";

export type SwapErrorCode =
  | "not_captured"
  | "capture_disabled"
  | "busy"
  | "swap_in_progress"
  | "flip_contested"
  | "unsupported_provider"
  | "missing_provider_binding"
  | "invalid_resume_cursor"
  | "missing_source_rollout"
  | "lhc_operation_failed"
  | "swap_failed";

export class SwapError extends Error {
  readonly code: SwapErrorCode;
  readonly stepReached: SwapStep;
  readonly retriable: boolean;
  readonly detail?: string;
  override readonly cause: unknown;

  constructor(input: {
    code: SwapErrorCode;
    message: string;
    stepReached: SwapStep;
    retriable?: boolean;
    detail?: string;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = "ClaudeSwapError";
    this.code = input.code;
    this.stepReached = input.stepReached;
    this.retriable = input.retriable ?? false;
    if (input.detail !== undefined) this.detail = input.detail;
    this.cause = input.cause;
  }
}

export interface ProviderBinding {
  threadId: string;
  provider: string;
  providerInstanceId?: string;
  resumeCursor?: unknown | null;
  runtimePayload?: unknown | null;
  runtimeMode?: string;
}

export interface ActiveSession {
  threadId: string;
  provider: string;
  activeTurnId?: string;
  cwd?: string;
}

export type CapturedThreadRef = { threadId: string; registryPath: string };

export interface ProviderEffects<Binding extends ProviderBinding, Cursor, Paths> {
  listSessions(): Promise<readonly ActiveSession[]>;
  stopSession(threadId: string): Promise<void>;
  readBinding(threadId: string): Promise<Binding | undefined>;
  writeResumeCursor(input: {
    threadId: string;
    binding: Binding;
    resumeCursor: Cursor;
  }): Promise<void>;
  resolvePaths(input: {
    threadId: string;
    binding: Binding;
    activeSession: ActiveSession | undefined;
  }): Promise<Paths>;
}

export interface CompactThreadOptions {
  profile?: string;
  params?: ViewCompactParams;
  signal?: { aborted: boolean };
}

export interface PruneThreadOptions {
  targetTokens?: number;
}

export interface LhcStatusThreadSummary {
  t3ThreadId: string;
  lhcThreadId: string;
  providerKind: string;
  createdAt: string;
  eventCount: number;
  turnCount: number;
  lastActivityAt: string | null;
  pending: number;
  pendingHigh: number;
}

export interface LhcStatusReceipt {
  capture: CaptureServiceStats;
  threads: LhcStatusThreadSummary[];
}

export interface LhcThreadInspectReceipt {
  t3ThreadId: string;
  lhcThreadId: string;
  providerKind: string;
  overview: InspectOverview;
  health: HealthReport;
  viewStatus: ViewStatus;
  tailTokens: number;
  compactRecommended: boolean;
}

export interface RebuiltArtifact {
  sessionId: string;
  rolloutPath: string;
  lineCount: number;
  expectedReintakeLines: number;
  replayedPrefixLines: number;
}

export interface SwapReceipt<Cursor> {
  op: SwapOperation;
  t3ThreadId: string;
  lhcThreadId: string;
  lhcResult: unknown;
  oldSessionId: string;
  newSessionId: string;
  rebuiltPath: string;
  rebuilt: Pick<RebuiltArtifact, "lineCount" | "expectedReintakeLines" | "replayedPrefixLines">;
  cursor: Cursor;
  timings: Record<SwapStep | "total", number>;
  runtimeNote: { recorded: true } | { recorded: false; error: string };
}

export interface SwapController<Cursor = unknown> {
  status(): Promise<LhcStatusReceipt>;
  inspectThread(t3ThreadId: string): Promise<LhcThreadInspectReceipt>;
  compactThread(t3ThreadId: string, options?: CompactThreadOptions): Promise<SwapReceipt<Cursor>>;
  pruneThread(t3ThreadId: string, options?: PruneThreadOptions): Promise<SwapReceipt<Cursor>>;
}

export interface SwapCoreDeps {
  readDir?: typeof NodeFSP.readdir;
  stat?: typeof NodeFSP.stat;
}

export interface SwapStrategy<_Binding extends ProviderBinding, Cursor, Paths> {
  providerLabel: string;
  supportedProviders: readonly string[];
  readCursor(value: unknown): Cursor | undefined;
  sessionIdFromCursor(cursor: Cursor): string | undefined;
  isValidSessionId(sessionId: string): boolean;
  invalidCursorDetail: string;
  buildNextCursor(input: { t3ThreadId: string; oldCursor: Cursor; newSessionId: string }): Cursor;
  cursorMatchesSession(cursor: Cursor | undefined, sessionId: string): boolean;
  rebuild(input: {
    op: SwapOperation;
    t3ThreadId: string;
    ref: CapturedThreadRef;
    view: SessionThreadView;
    paths: Paths;
    oldSessionId: string;
    lhcResult: unknown;
    rawOptions: CompactThreadOptions | PruneThreadOptions | undefined;
    deps: Required<SwapCoreDeps>;
  }): Promise<RebuiltArtifact>;
}

export interface SwapControllerOptions<Binding extends ProviderBinding, Cursor, Paths> {
  capture: CaptureService;
  provider: ProviderEffects<Binding, Cursor, Paths>;
  strategy: SwapStrategy<Binding, Cursor, Paths>;
  now?: () => number;
  readDir?: typeof NodeFSP.readdir;
  stat?: typeof NodeFSP.stat;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidSessionId(sessionId: string): boolean {
  return UUID_RE.test(sessionId);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPersistedCwd(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const cwd = payload.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : undefined;
}

export function persistedCwdFromBindingOrSession(input: {
  binding: ProviderBinding;
  activeSession: ActiveSession | undefined;
}): string | undefined {
  return readPersistedCwd(input.binding.runtimePayload) ?? input.activeSession?.cwd;
}

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertOk<T>(result: OpResult<T>, step: SwapStep, code: SwapErrorCode): T {
  if (result.ok) return result.value;
  throw new SwapError({
    code,
    stepReached: step,
    message: result.error.reason,
    detail: `${result.error.code}: ${result.error.reason}`,
  });
}

function observedCursorDetail<Cursor>(cursor: Cursor | undefined): string {
  if (cursor === undefined) return "observed cursor: <missing>";
  return `observed cursor: ${JSON.stringify(cursor)}`;
}

function activeSessionForThread(
  sessions: readonly ActiveSession[],
  t3ThreadId: string,
): ActiveSession | undefined {
  return sessions.find((session) => session.threadId === t3ThreadId);
}

function flipContestedError(input: { message: string; detail?: string }): SwapError {
  return new SwapError({
    code: "flip_contested",
    message: input.message,
    stepReached: "cursor-flip",
    retriable: true,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

function summaryFromOverview(
  row: ReturnType<CaptureService["listCapturedThreads"]>[number],
  overview: InspectOverview,
  events: { recordedAt: string }[],
): Omit<LhcStatusThreadSummary, "pending" | "pendingHigh"> {
  return {
    t3ThreadId: row.t3ThreadId,
    lhcThreadId: row.lhcThreadId,
    providerKind: row.providerKind,
    createdAt: row.createdAt,
    eventCount: overview.events.count,
    turnCount: overview.turns.open + overview.turns.closed,
    lastActivityAt: events.at(-1)?.recordedAt ?? null,
  };
}

export async function findFileByName(
  root: string,
  targetName: string,
  deps: Pick<Required<SwapCoreDeps>, "readDir">,
): Promise<string | undefined> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = await deps.readDir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = NodePath.join(dir, entry.name);
      if (entry.isFile() && entry.name === targetName) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return undefined;
}

async function requireThreadRef(
  capture: CaptureService,
  t3ThreadId: string,
): Promise<CapturedThreadRef> {
  if (!capture.enabled || capture.sdk === undefined) {
    throw new SwapError({
      code: "capture_disabled",
      message: "LHC capture is disabled.",
      stepReached: "resolve-lineage",
      retriable: false,
    });
  }
  const ref = capture.lookupThread(t3ThreadId);
  if (ref === undefined) {
    throw new SwapError({
      code: "not_captured",
      message: `Thread '${t3ThreadId}' is not captured by LHC.`,
      stepReached: "resolve-lineage",
    });
  }
  return ref;
}

function emptyTimings(): Record<SwapStep | "total", number> {
  return {
    "resolve-lineage": 0,
    "busy-check": 0,
    "read-binding": 0,
    "lhc-operation": 0,
    "render-view": 0,
    quiesce: 0,
    "resolve-paths": 0,
    rebuild: 0,
    "preflip-validate": 0,
    "cursor-flip": 0,
    "runtime-note": 0,
    receipt: 0,
    total: 0,
  };
}

export function createSwapController<Binding extends ProviderBinding, Cursor, Paths>(
  options: SwapControllerOptions<Binding, Cursor, Paths>,
): SwapController<Cursor> {
  const capture = options.capture;
  const provider = options.provider;
  const strategy = options.strategy;
  const now = options.now ?? (() => Date.now());
  const deps = {
    readDir: options.readDir ?? NodeFSP.readdir,
    stat: options.stat ?? NodeFSP.stat,
  };
  // This lock serializes LHC swaps only. It does not block ProviderService.sendTurn,
  // which may start a fresh provider session from the old cursor while a swap is
  // quiescing/rebuilding. Window A is accepted for v1: a turn that races after the
  // initial busy check can be interrupted by quiesce; its content remains in LHC,
  // but drops from the resumed provider rollout. Window B is guarded below: a turn
  // that restarts between quiesce and cursor flip is detected as a contested flip
  // before or immediately after the write, never reported as a successful receipt.
  const locks = new Set<string>();

  async function status(): Promise<LhcStatusReceipt> {
    const captureStats = capture.stats();
    const sdk = capture.sdk;
    if (!capture.enabled || sdk === undefined) {
      return { capture: captureStats, threads: [] };
    }
    const captureByThread = new Map(
      captureStats.threads.map((thread) => [thread.t3ThreadId, thread] as const),
    );
    const threads: LhcStatusThreadSummary[] = [];
    for (const row of capture.listCapturedThreads()) {
      const ref = capture.lookupThread(row.t3ThreadId);
      if (ref === undefined) continue;
      const overview = assertOk(await sdk.inspect.overview(ref), "receipt", "swap_failed");
      const events = assertOk(await sdk.intakeStream.listEvents(ref), "receipt", "swap_failed");
      const captureThread = captureByThread.get(row.t3ThreadId);
      threads.push({
        ...summaryFromOverview(row, overview, events),
        pending: captureThread?.pending ?? 0,
        pendingHigh: captureThread?.pendingHigh ?? 0,
      });
    }
    return { capture: captureStats, threads };
  }

  async function inspectThread(t3ThreadId: string): Promise<LhcThreadInspectReceipt> {
    const ref = await requireThreadRef(capture, t3ThreadId);
    const lineageRow = capture.listCapturedThreads().find((row) => row.t3ThreadId === t3ThreadId);
    const sdk = capture.sdk!;
    const overview = assertOk(await sdk.inspect.overview(ref), "receipt", "swap_failed");
    const health = assertOk(await sdk.inspect.health(ref), "receipt", "swap_failed");
    const viewStatus = assertOk(await sdk.threadView.status(ref), "receipt", "swap_failed");
    return {
      t3ThreadId,
      lhcThreadId: ref.threadId,
      providerKind: lineageRow?.providerKind ?? "unknown",
      overview,
      health,
      viewStatus,
      tailTokens: viewStatus.tailTokens,
      compactRecommended: viewStatus.compactRecommended,
    };
  }

  async function withStep<T>(
    timings: Record<SwapStep | "total", number>,
    step: SwapStep,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = now();
    try {
      return await fn();
    } catch (cause) {
      if (cause instanceof SwapError) throw cause;
      throw new SwapError({
        code: "swap_failed",
        message: `${step} failed: ${detail(cause)}`,
        detail: detail(cause),
        stepReached: step,
        cause,
      });
    } finally {
      timings[step] += Math.max(0, now() - started);
    }
  }

  async function runSwap(
    op: SwapOperation,
    t3ThreadId: string,
    rawOptions: CompactThreadOptions | PruneThreadOptions | undefined,
  ): Promise<SwapReceipt<Cursor>> {
    if (locks.has(t3ThreadId)) {
      throw new SwapError({
        code: "swap_in_progress",
        message: `An LHC ${strategy.providerLabel} swap is already in progress for '${t3ThreadId}'.`,
        stepReached: "busy-check",
        retriable: true,
      });
    }
    locks.add(t3ThreadId);
    const totalStarted = now();
    const timings = emptyTimings();
    try {
      const ref = await withStep(timings, "resolve-lineage", () =>
        requireThreadRef(capture, t3ThreadId),
      );
      const sdk = capture.sdk as Lhc;

      const activeSession = await withStep(timings, "busy-check", async () => {
        const sessions = await provider.listSessions();
        const active = activeSessionForThread(sessions, t3ThreadId);
        if (active?.activeTurnId !== undefined) {
          throw new SwapError({
            code: "busy",
            message: `Thread '${t3ThreadId}' has an in-flight provider turn.`,
            stepReached: "busy-check",
            retriable: true,
          });
        }
        return active;
      });

      const binding = await withStep(timings, "read-binding", async () => {
        const value = await provider.readBinding(t3ThreadId);
        if (value === undefined) {
          throw new SwapError({
            code: "missing_provider_binding",
            message: `Thread '${t3ThreadId}' has no provider runtime binding.`,
            stepReached: "read-binding",
          });
        }
        if (!strategy.supportedProviders.includes(value.provider)) {
          throw new SwapError({
            code: "unsupported_provider",
            message: `Thread '${t3ThreadId}' is bound to unsupported provider '${value.provider}'.`,
            stepReached: "read-binding",
          });
        }
        return value;
      });

      const oldCursor = strategy.readCursor(binding.resumeCursor);
      const oldSessionId =
        oldCursor === undefined ? undefined : strategy.sessionIdFromCursor(oldCursor);
      if (
        oldCursor === undefined ||
        oldSessionId === undefined ||
        !strategy.isValidSessionId(oldSessionId)
      ) {
        throw new SwapError({
          code: "invalid_resume_cursor",
          message: `Thread '${t3ThreadId}' does not have a valid ${strategy.providerLabel} resume cursor.`,
          stepReached: "read-binding",
          detail: strategy.invalidCursorDetail,
        });
      }

      const lhcResult = await withStep(timings, "lhc-operation", async () => {
        if (op === "compact") {
          return assertOk(
            await sdk.threadView.compact(ref, (rawOptions ?? {}) as CompactThreadOptions),
            "lhc-operation",
            "lhc_operation_failed",
          );
        }
        return assertOk(
          await sdk.threadView.prune(ref, (rawOptions ?? {}) as PruneThreadOptions),
          "lhc-operation",
          "lhc_operation_failed",
        );
      });

      const view = await withStep(timings, "render-view", async () =>
        assertOk(await sdk.threadView.getSessionThreadView(ref), "render-view", "swap_failed"),
      );

      await withStep(timings, "quiesce", async () => provider.stopSession(t3ThreadId));

      const paths = await withStep(timings, "resolve-paths", async () =>
        provider.resolvePaths({ threadId: t3ThreadId, binding, activeSession }),
      );

      const rebuilt = await withStep(timings, "rebuild", async () =>
        strategy.rebuild({
          op,
          t3ThreadId,
          ref,
          view: view as SessionThreadView,
          paths,
          oldSessionId,
          lhcResult,
          rawOptions,
          deps,
        }),
      );

      await withStep(timings, "preflip-validate", async () => {
        if (!strategy.isValidSessionId(rebuilt.sessionId)) {
          throw new SwapError({
            code: "invalid_resume_cursor",
            message: `Rebuilt ${strategy.providerLabel} session id '${rebuilt.sessionId}' is invalid.`,
            stepReached: "preflip-validate",
          });
        }
        const stat = await deps.stat(rebuilt.rolloutPath);
        if (!stat.isFile()) {
          throw new Error(`rebuilt rollout path is not a file: ${rebuilt.rolloutPath}`);
        }
      });

      const nextCursor = strategy.buildNextCursor({
        t3ThreadId,
        oldCursor,
        newSessionId: rebuilt.sessionId,
      });

      await withStep(timings, "cursor-flip", async () => {
        const preflipActive = activeSessionForThread(await provider.listSessions(), t3ThreadId);
        if (preflipActive !== undefined) {
          throw flipContestedError({
            message: `Thread '${t3ThreadId}' restarted a provider session before the LHC cursor flip.`,
            detail: JSON.stringify({
              observedSession: {
                threadId: preflipActive.threadId,
                provider: preflipActive.provider,
                activeTurnId: preflipActive.activeTurnId ?? null,
              },
            }),
          });
        }

        // Cursor flip is intentionally the LAST provider-state mutation. Up to
        // this awaited write, the persisted cursor still names the old,
        // still-valid rollout; any failure before here leaves future provider
        // recovery on the original session.
        await provider.writeResumeCursor({
          threadId: t3ThreadId,
          binding,
          resumeCursor: nextCursor,
        });

        const verify = async () =>
          strategy.readCursor((await provider.readBinding(t3ThreadId))?.resumeCursor);
        let observedCursor = await verify();
        if (strategy.cursorMatchesSession(observedCursor, rebuilt.sessionId)) return;

        const afterFlipActive = activeSessionForThread(await provider.listSessions(), t3ThreadId);
        if (afterFlipActive !== undefined) {
          throw flipContestedError({
            message: `Thread '${t3ThreadId}' cursor flip was clobbered by an active provider session.`,
            detail: JSON.stringify({
              expectedResume: rebuilt.sessionId,
              observedCursor,
              observedSession: {
                threadId: afterFlipActive.threadId,
                provider: afterFlipActive.provider,
                activeTurnId: afterFlipActive.activeTurnId ?? null,
              },
            }),
          });
        }

        await provider.writeResumeCursor({
          threadId: t3ThreadId,
          binding,
          resumeCursor: nextCursor,
        });
        observedCursor = await verify();
        if (!strategy.cursorMatchesSession(observedCursor, rebuilt.sessionId)) {
          throw flipContestedError({
            message: `Thread '${t3ThreadId}' cursor flip was clobbered after one idle retry.`,
            detail: JSON.stringify({
              expectedResume: rebuilt.sessionId,
              observedCursor: observedCursorDetail(observedCursor),
            }),
          });
        }
      });

      const runtimeNote = await withStep(timings, "runtime-note", async () => {
        const profile =
          op === "compact" && "profile" in (rawOptions ?? {})
            ? (rawOptions as CompactThreadOptions).profile
            : undefined;
        const note = swapRuntimeNote({
          op,
          oldSessionId,
          newSessionId: rebuilt.sessionId,
          ...(profile !== undefined ? { profile } : {}),
        });
        const result = await sdk.intakeStream.messageEvents(ref, [note]);
        if (result.ok) return { recorded: true as const };
        return { recorded: false as const, error: result.error.reason };
      });

      timings.total = Math.max(0, now() - totalStarted);
      timings.receipt = 0;
      return {
        op,
        t3ThreadId,
        lhcThreadId: ref.threadId,
        lhcResult,
        oldSessionId,
        newSessionId: rebuilt.sessionId,
        rebuiltPath: rebuilt.rolloutPath,
        rebuilt: {
          lineCount: rebuilt.lineCount,
          expectedReintakeLines: rebuilt.expectedReintakeLines,
          replayedPrefixLines: rebuilt.replayedPrefixLines,
        },
        cursor: nextCursor,
        timings,
        runtimeNote,
      };
    } finally {
      locks.delete(t3ThreadId);
    }
  }

  return {
    status,
    inspectThread,
    compactThread: (t3ThreadId, compactOptions) => runSwap("compact", t3ThreadId, compactOptions),
    pruneThread: (t3ThreadId, pruneOptions) => runSwap("prune", t3ThreadId, pruneOptions),
  };
}

function swapRuntimeNote(input: {
  op: SwapOperation;
  oldSessionId: string;
  newSessionId: string;
  profile?: string;
}): MessageEventInput {
  const text = `swap performed: op=${input.op} oldSessionId=${input.oldSessionId} newSessionId=${input.newSessionId} profile=${input.profile ?? "default"}`;
  return {
    eventKind: "runtime_note",
    idempotencyKey: `t3lhc:swap:${input.op}:${input.oldSessionId}:${input.newSessionId}:${input.profile ?? "default"}:runtime_note`,
    actor: "t3code-lhc",
    harness: "t3",
    payload: { text },
  };
}
