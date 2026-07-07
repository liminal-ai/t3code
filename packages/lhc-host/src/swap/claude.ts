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
import {
  writeRebuiltRollout,
  type WriteRebuiltRolloutResult,
} from "../claude-swap/write-rebuilt.ts";

export type ClaudeSwapOperation = "compact" | "prune";

export type ClaudeSwapStep =
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

export type ClaudeSwapErrorCode =
  | "not_captured"
  | "capture_disabled"
  | "busy"
  | "swap_in_progress"
  | "flip_contested"
  | "not_claude"
  | "missing_provider_binding"
  | "invalid_resume_cursor"
  | "missing_source_rollout"
  | "lhc_operation_failed"
  | "swap_failed";

export class ClaudeSwapError extends Error {
  readonly code: ClaudeSwapErrorCode;
  readonly stepReached: ClaudeSwapStep;
  readonly retriable: boolean;
  readonly detail?: string;
  override readonly cause: unknown;

  constructor(input: {
    code: ClaudeSwapErrorCode;
    message: string;
    stepReached: ClaudeSwapStep;
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

export interface ClaudeSwapCursor {
  threadId?: string;
  resume?: string;
  resumeSessionAt?: string;
  turnCount?: number;
}

export interface ClaudeProviderBinding {
  threadId: string;
  provider: string;
  providerInstanceId?: string;
  resumeCursor?: unknown | null;
  runtimePayload?: unknown | null;
  runtimeMode?: string;
}

export interface ClaudeActiveSession {
  threadId: string;
  provider: string;
  activeTurnId?: string;
  cwd?: string;
}

export interface ClaudeSwapPaths {
  cwd: string;
  claudeHomePath: string;
  claudeProjectsDir: string;
}

type CapturedThreadRef = { threadId: string; registryPath: string };

export interface ClaudeSwapProviderEffects {
  listSessions(): Promise<readonly ClaudeActiveSession[]>;
  stopSession(threadId: string): Promise<void>;
  readBinding(threadId: string): Promise<ClaudeProviderBinding | undefined>;
  writeResumeCursor(input: {
    threadId: string;
    binding: ClaudeProviderBinding;
    resumeCursor: ClaudeSwapCursor;
  }): Promise<void>;
  resolvePaths(input: {
    threadId: string;
    binding: ClaudeProviderBinding;
    activeSession: ClaudeActiveSession | undefined;
  }): Promise<ClaudeSwapPaths>;
}

export interface ClaudeSwapControllerOptions {
  capture: CaptureService;
  provider: ClaudeSwapProviderEffects;
  now?: () => number;
  readDir?: typeof NodeFSP.readdir;
  stat?: typeof NodeFSP.stat;
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
  /** Capture intake queue depth for this thread (currently queued + in-flight). */
  pending: number;
  /** Max pending depth ever observed for this thread. */
  pendingHigh: number;
}

export interface LhcStatusReceipt {
  capture: CaptureServiceStats;
  threads: LhcStatusThreadSummary[];
}

export interface LhcThreadInspectReceipt {
  t3ThreadId: string;
  lhcThreadId: string;
  overview: InspectOverview;
  health: HealthReport;
  viewStatus: ViewStatus;
  /** Operator shortcut — mirrors `viewStatus.tailTokens`. */
  tailTokens: number;
  /** Operator shortcut — mirrors `viewStatus.compactRecommended`. */
  compactRecommended: boolean;
}

export interface ClaudeSwapReceipt {
  op: ClaudeSwapOperation;
  t3ThreadId: string;
  lhcThreadId: string;
  lhcResult: unknown;
  oldSessionId: string;
  newSessionId: string;
  rebuiltPath: string;
  rebuilt: Pick<
    WriteRebuiltRolloutResult,
    "lineCount" | "expectedReintakeLines" | "replayedPrefixLines"
  >;
  cursor: ClaudeSwapCursor;
  timings: Record<ClaudeSwapStep | "total", number>;
  runtimeNote: { recorded: true } | { recorded: false; error: string };
}

const CLAUDE_PROVIDER = "claudeAgent";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertOk<T>(result: OpResult<T>, step: ClaudeSwapStep, code: ClaudeSwapErrorCode): T {
  if (result.ok) return result.value;
  throw new ClaudeSwapError({
    code,
    stepReached: step,
    message: result.error.reason,
    detail: `${result.error.code}: ${result.error.reason}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCursor(value: unknown): ClaudeSwapCursor | undefined {
  if (!isRecord(value)) return undefined;
  const cursor: ClaudeSwapCursor = {};
  if (typeof value.threadId === "string") cursor.threadId = value.threadId;
  if (typeof value.resume === "string") cursor.resume = value.resume;
  if (typeof value.resumeSessionAt === "string") cursor.resumeSessionAt = value.resumeSessionAt;
  if (typeof value.turnCount === "number") cursor.turnCount = value.turnCount;
  return cursor;
}

function observedCursorDetail(cursor: ClaudeSwapCursor | undefined): string {
  if (cursor === undefined) return "observed cursor: <missing>";
  return `observed cursor: ${JSON.stringify(cursor)}`;
}

function activeSessionForThread(
  sessions: readonly ClaudeActiveSession[],
  t3ThreadId: string,
): ClaudeActiveSession | undefined {
  return sessions.find((session) => session.threadId === t3ThreadId);
}

function flipContestedError(input: { message: string; detail?: string }): ClaudeSwapError {
  return new ClaudeSwapError({
    code: "flip_contested",
    message: input.message,
    stepReached: "cursor-flip",
    retriable: true,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
  });
}

function readPersistedCwd(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const cwd = payload.cwd;
  return typeof cwd === "string" && cwd.trim() !== "" ? cwd : undefined;
}

function carriedTurnCount(cursor: ClaudeSwapCursor): number {
  return Number.isInteger(cursor.turnCount) &&
    cursor.turnCount !== undefined &&
    cursor.turnCount >= 0
    ? cursor.turnCount
    : 0;
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

async function findRolloutBySessionId(
  claudeProjectsDir: string,
  sessionId: string,
  deps: Pick<Required<ClaudeSwapControllerOptions>, "readDir" | "stat">,
): Promise<string | undefined> {
  const targetName = `${sessionId}.jsonl`;
  const stack = [claudeProjectsDir];
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
    throw new ClaudeSwapError({
      code: "capture_disabled",
      message: "LHC capture is disabled.",
      stepReached: "resolve-lineage",
      retriable: false,
    });
  }
  const ref = capture.lookupThread(t3ThreadId);
  if (ref === undefined) {
    throw new ClaudeSwapError({
      code: "not_captured",
      message: `Thread '${t3ThreadId}' is not captured by LHC.`,
      stepReached: "resolve-lineage",
    });
  }
  return ref;
}

function emptyTimings(): Record<ClaudeSwapStep | "total", number> {
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

export interface ClaudeSwapController {
  status(): Promise<LhcStatusReceipt>;
  inspectThread(t3ThreadId: string): Promise<LhcThreadInspectReceipt>;
  compactThread(t3ThreadId: string, options?: CompactThreadOptions): Promise<ClaudeSwapReceipt>;
  pruneThread(t3ThreadId: string, options?: PruneThreadOptions): Promise<ClaudeSwapReceipt>;
}

export function createClaudeSwapController(
  options: ClaudeSwapControllerOptions,
): ClaudeSwapController {
  const capture = options.capture;
  const provider = options.provider;
  const now = options.now ?? (() => Date.now());
  const deps = {
    readDir: options.readDir ?? NodeFSP.readdir,
    stat: options.stat ?? NodeFSP.stat,
  };
  // This lock serializes LHC swaps only. It does not block ProviderService.sendTurn,
  // which may start a fresh Claude session from the old cursor while a swap is
  // quiescing/rebuilding. Window A is accepted for v1: a turn that races after the
  // initial busy check can be interrupted by quiesce; its content remains in LHC,
  // but drops from the resumed Claude rollout. Window B is guarded below: a turn
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
    const sdk = capture.sdk!;
    const overview = assertOk(await sdk.inspect.overview(ref), "receipt", "swap_failed");
    const health = assertOk(await sdk.inspect.health(ref), "receipt", "swap_failed");
    const viewStatus = assertOk(await sdk.threadView.status(ref), "receipt", "swap_failed");
    return {
      t3ThreadId,
      lhcThreadId: ref.threadId,
      overview,
      health,
      viewStatus,
      tailTokens: viewStatus.tailTokens,
      compactRecommended: viewStatus.compactRecommended,
    };
  }

  async function withStep<T>(
    timings: Record<ClaudeSwapStep | "total", number>,
    step: ClaudeSwapStep,
    fn: () => Promise<T>,
  ): Promise<T> {
    const started = now();
    try {
      return await fn();
    } catch (cause) {
      if (cause instanceof ClaudeSwapError) throw cause;
      throw new ClaudeSwapError({
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
    op: ClaudeSwapOperation,
    t3ThreadId: string,
    rawOptions: CompactThreadOptions | PruneThreadOptions | undefined,
  ): Promise<ClaudeSwapReceipt> {
    if (locks.has(t3ThreadId)) {
      throw new ClaudeSwapError({
        code: "swap_in_progress",
        message: `A Claude LHC swap is already in progress for '${t3ThreadId}'.`,
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
          throw new ClaudeSwapError({
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
          throw new ClaudeSwapError({
            code: "missing_provider_binding",
            message: `Thread '${t3ThreadId}' has no provider runtime binding.`,
            stepReached: "read-binding",
          });
        }
        if (value.provider !== CLAUDE_PROVIDER) {
          throw new ClaudeSwapError({
            code: "not_claude",
            message: `Thread '${t3ThreadId}' is bound to '${value.provider}', not Claude.`,
            stepReached: "read-binding",
          });
        }
        return value;
      });

      const oldCursor = readCursor(binding.resumeCursor);
      const oldSessionId = oldCursor?.resume;
      if (oldCursor === undefined || oldSessionId === undefined || !UUID_RE.test(oldSessionId)) {
        throw new ClaudeSwapError({
          code: "invalid_resume_cursor",
          message: `Thread '${t3ThreadId}' does not have a valid Claude resume cursor.`,
          stepReached: "read-binding",
          detail:
            "Claude swap must write a uuid resume cursor; malformed cursors silently fresh-start in the adapter.",
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

      const sourceRolloutPath = await withStep(timings, "resolve-paths", async () =>
        findRolloutBySessionId(paths.claudeProjectsDir, oldSessionId, deps),
      );
      if (sourceRolloutPath === undefined) {
        throw new ClaudeSwapError({
          code: "missing_source_rollout",
          message: `Could not find Claude rollout for session '${oldSessionId}'.`,
          stepReached: "resolve-paths",
          detail: `searched ${paths.claudeProjectsDir}`,
        });
      }

      const rebuilt = await withStep(timings, "rebuild", async () =>
        writeRebuiltRollout({
          view: view as SessionThreadView,
          cwd: paths.cwd,
          claudeProjectsDir: paths.claudeProjectsDir,
          sourceRolloutPath,
          swapReceipt: { oldSessionId },
        }),
      );

      await withStep(timings, "preflip-validate", async () => {
        if (!UUID_RE.test(rebuilt.sessionId)) {
          throw new ClaudeSwapError({
            code: "invalid_resume_cursor",
            message: `Rebuilt Claude session id '${rebuilt.sessionId}' is not a uuid.`,
            stepReached: "preflip-validate",
          });
        }
        const stat = await deps.stat(rebuilt.rolloutPath);
        if (!stat.isFile()) {
          throw new Error(`rebuilt rollout path is not a file: ${rebuilt.rolloutPath}`);
        }
      });

      const nextCursor: ClaudeSwapCursor = {
        threadId: t3ThreadId,
        resume: rebuilt.sessionId,
        turnCount: carriedTurnCount(oldCursor),
      };

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
        // recovery on the original Claude session.
        await provider.writeResumeCursor({
          threadId: t3ThreadId,
          binding,
          resumeCursor: nextCursor,
        });

        const verify = async () =>
          readCursor((await provider.readBinding(t3ThreadId))?.resumeCursor);
        let observedCursor = await verify();
        if (observedCursor?.resume === rebuilt.sessionId) return;

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
        if (observedCursor?.resume !== rebuilt.sessionId) {
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
  op: ClaudeSwapOperation;
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

export function persistedCwdFromBindingOrSession(input: {
  binding: ClaudeProviderBinding;
  activeSession: ClaudeActiveSession | undefined;
}): string | undefined {
  return readPersistedCwd(input.binding.runtimePayload) ?? input.activeSession?.cwd;
}
