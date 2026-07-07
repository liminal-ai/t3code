// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodePath from "node:path";

import type { SessionThreadView } from "lhc";

import {
  writeRebuiltRollout,
  type WriteRebuiltRolloutResult,
} from "../claude-swap/write-rebuilt.ts";
import {
  createSwapController,
  findFileByName,
  isRecord,
  isUuidSessionId,
  persistedCwdFromBindingOrSession,
  SwapError,
  type ActiveSession,
  type CompactThreadOptions,
  type LhcStatusReceipt,
  type LhcThreadInspectReceipt,
  type ProviderBinding,
  type ProviderEffects,
  type PruneThreadOptions,
  type RebuiltArtifact,
  type SwapController,
  type SwapControllerOptions,
  type SwapErrorCode,
  type SwapOperation,
  type SwapReceipt,
  type SwapStep,
  type SwapStrategy,
} from "./core.ts";

export type ClaudeSwapOperation = SwapOperation;
export type ClaudeSwapStep = SwapStep;
export type ClaudeSwapErrorCode = SwapErrorCode;
export const ClaudeSwapError = SwapError;
export type ClaudeSwapError = SwapError;

export interface ClaudeSwapCursor {
  threadId?: string;
  resume?: string;
  resumeSessionAt?: string;
  turnCount?: number;
}

export interface ClaudeProviderBinding extends ProviderBinding {}
export interface ClaudeActiveSession extends ActiveSession {}

export interface ClaudeSwapPaths {
  cwd: string;
  claudeHomePath: string;
  claudeProjectsDir: string;
}

export interface ClaudeSwapProviderEffects extends ProviderEffects<
  ClaudeProviderBinding,
  ClaudeSwapCursor,
  ClaudeSwapPaths
> {}

export interface ClaudeSwapControllerOptions extends Omit<
  SwapControllerOptions<ClaudeProviderBinding, ClaudeSwapCursor, ClaudeSwapPaths>,
  "strategy"
> {}

export type { CompactThreadOptions, PruneThreadOptions, LhcStatusReceipt, LhcThreadInspectReceipt };

export interface ClaudeSwapReceipt extends SwapReceipt<ClaudeSwapCursor> {
  rebuilt: Pick<
    WriteRebuiltRolloutResult,
    "lineCount" | "expectedReintakeLines" | "replayedPrefixLines"
  >;
}

export interface ClaudeSwapController extends SwapController<ClaudeSwapCursor> {
  compactThread(t3ThreadId: string, options?: CompactThreadOptions): Promise<ClaudeSwapReceipt>;
  pruneThread(t3ThreadId: string, options?: PruneThreadOptions): Promise<ClaudeSwapReceipt>;
}

const CLAUDE_PROVIDER = "claudeAgent";

function readCursor(value: unknown): ClaudeSwapCursor | undefined {
  if (!isRecord(value)) return undefined;
  const cursor: ClaudeSwapCursor = {};
  if (typeof value.threadId === "string") cursor.threadId = value.threadId;
  if (typeof value.resume === "string") cursor.resume = value.resume;
  if (typeof value.resumeSessionAt === "string") cursor.resumeSessionAt = value.resumeSessionAt;
  if (typeof value.turnCount === "number") cursor.turnCount = value.turnCount;
  return cursor;
}

function carriedTurnCount(cursor: ClaudeSwapCursor): number {
  return Number.isInteger(cursor.turnCount) &&
    cursor.turnCount !== undefined &&
    cursor.turnCount >= 0
    ? cursor.turnCount
    : 0;
}

function sourceRolloutName(sessionId: string): string {
  return `${sessionId}.jsonl`;
}

const claudeStrategy: SwapStrategy<ClaudeProviderBinding, ClaudeSwapCursor, ClaudeSwapPaths> = {
  providerLabel: "Claude",
  supportedProviders: [CLAUDE_PROVIDER],
  readCursor,
  sessionIdFromCursor: (cursor) => cursor.resume,
  isValidSessionId: isUuidSessionId,
  invalidCursorDetail:
    "Claude swap must write a uuid resume cursor; malformed cursors silently fresh-start in the adapter.",
  buildNextCursor: ({ t3ThreadId, oldCursor, newSessionId }) => ({
    threadId: t3ThreadId,
    resume: newSessionId,
    turnCount: carriedTurnCount(oldCursor),
  }),
  cursorMatchesSession: (cursor, sessionId) => cursor?.resume === sessionId,
  rebuild: async ({ view, paths, oldSessionId, deps }) => {
    const sourceRolloutPath = await findFileByName(
      paths.claudeProjectsDir,
      sourceRolloutName(oldSessionId),
      deps,
    );
    if (sourceRolloutPath === undefined) {
      throw new SwapError({
        code: "missing_source_rollout",
        message: `Could not find Claude rollout for session '${oldSessionId}'.`,
        stepReached: "resolve-paths",
        detail: `searched ${paths.claudeProjectsDir}`,
      });
    }

    const rebuilt = await writeRebuiltRollout({
      view: view as SessionThreadView,
      cwd: paths.cwd,
      claudeProjectsDir: paths.claudeProjectsDir,
      sourceRolloutPath,
      swapReceipt: { oldSessionId },
    });
    return rebuilt satisfies RebuiltArtifact;
  },
};

export function createClaudeSwapController(
  options: ClaudeSwapControllerOptions,
): ClaudeSwapController {
  return createSwapController({
    ...options,
    strategy: claudeStrategy,
  }) as ClaudeSwapController;
}

export function claudeProjectsDirFromHome(claudeHomePath: string): string {
  return NodePath.join(claudeHomePath, ".claude", "projects");
}

export { persistedCwdFromBindingOrSession };
export {
  codexSessionsDirFromHome,
  createCodexSwapController,
  type CodexActiveSession,
  type CodexProviderBinding,
  type CodexSwapController,
  type CodexSwapControllerOptions,
  type CodexSwapCursor,
  type CodexSwapPaths,
  type CodexSwapProviderEffects,
  type CodexSwapReceipt,
} from "./codex.ts";
export {
  createSwapController,
  type ActiveSession,
  type ProviderBinding,
  type ProviderEffects,
  type RebuiltArtifact,
  type SwapController,
  type SwapControllerOptions,
  type SwapReceipt,
  type SwapStrategy,
} from "./core.ts";
