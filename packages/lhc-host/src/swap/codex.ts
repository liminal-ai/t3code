// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionThreadView } from "lhc";

import {
  writeRebuiltRollout,
  type WriteRebuiltRolloutResult,
} from "../codex-swap/write-rebuilt.ts";
import {
  createSwapController,
  isRecord,
  isUuidSessionId,
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
  type SwapReceipt,
  type SwapStrategy,
} from "./core.ts";

export interface CodexSwapCursor {
  threadId: string;
}

export interface CodexProviderBinding extends ProviderBinding {}
export interface CodexActiveSession extends ActiveSession {}

export interface CodexSwapPaths {
  cwd: string;
  codexHome: string;
  codexSessionsDir: string;
}

export interface CodexSwapProviderEffects extends ProviderEffects<
  CodexProviderBinding,
  CodexSwapCursor,
  CodexSwapPaths
> {}

export interface CodexSwapControllerOptions extends Omit<
  SwapControllerOptions<CodexProviderBinding, CodexSwapCursor, CodexSwapPaths>,
  "strategy"
> {}

export type { CompactThreadOptions, PruneThreadOptions, LhcStatusReceipt, LhcThreadInspectReceipt };

export interface CodexSwapReceipt extends SwapReceipt<CodexSwapCursor> {
  rebuilt: Pick<RebuiltArtifact, "lineCount" | "expectedReintakeLines" | "replayedPrefixLines">;
}

export interface CodexSwapController extends SwapController<CodexSwapCursor> {
  compactThread(t3ThreadId: string, options?: CompactThreadOptions): Promise<CodexSwapReceipt>;
  pruneThread(t3ThreadId: string, options?: PruneThreadOptions): Promise<CodexSwapReceipt>;
}

const CODEX_PROVIDER = "codex";

function readCursor(value: unknown): CodexSwapCursor | undefined {
  if (!isRecord(value)) return undefined;
  return typeof value.threadId === "string" ? { threadId: value.threadId } : undefined;
}

function rolloutFilenameSessionId(fileName: string): string | undefined {
  const match = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/u.exec(fileName);
  return match?.[1];
}

async function findCodexRolloutBySessionId(
  sessionsDir: string,
  sessionId: string,
  readDir: typeof NodeFSP.readdir,
): Promise<string | undefined> {
  const stack = [sessionsDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: NodeFS.Dirent[];
    try {
      entries = await readDir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = NodePath.join(dir, entry.name);
      if (entry.isFile() && rolloutFilenameSessionId(entry.name) === sessionId) return fullPath;
      if (entry.isDirectory()) stack.push(fullPath);
    }
  }
  return undefined;
}

const codexStrategy: SwapStrategy<CodexProviderBinding, CodexSwapCursor, CodexSwapPaths> = {
  providerLabel: "Codex",
  supportedProviders: [CODEX_PROVIDER],
  readCursor,
  sessionIdFromCursor: (cursor) => cursor.threadId,
  isValidSessionId: isUuidSessionId,
  invalidCursorDetail:
    "Codex swap must write a bare { threadId } uuid cursor; malformed cursors can silently fresh-start in the adapter.",
  buildNextCursor: ({ newSessionId }) => ({ threadId: newSessionId }),
  cursorMatchesSession: (cursor, sessionId) => cursor?.threadId === sessionId,
  rebuild: async ({ op, t3ThreadId, view, paths, oldSessionId, deps }) => {
    const sourceRolloutPath = await findCodexRolloutBySessionId(
      paths.codexSessionsDir,
      oldSessionId,
      deps.readDir,
    );
    if (sourceRolloutPath === undefined) {
      throw new SwapError({
        code: "missing_source_rollout",
        message: `Could not find Codex rollout for thread id '${oldSessionId}'.`,
        stepReached: "resolve-paths",
        detail: `searched ${paths.codexSessionsDir}`,
      });
    }
    const rebuilt: WriteRebuiltRolloutResult = await writeRebuiltRollout({
      view: view as SessionThreadView,
      cwd: paths.cwd,
      codexHome: paths.codexHome,
      sourceRolloutPath,
      swapReceipt: { oldSessionId, threadId: t3ThreadId, op },
    });
    return {
      sessionId: rebuilt.sessionId,
      rolloutPath: rebuilt.rolloutPath,
      lineCount: rebuilt.lineCount,
      expectedReintakeLines: rebuilt.expectedReintakeLines,
      replayedPrefixLines: rebuilt.replayedPrefixLines,
    };
  },
};

export function createCodexSwapController(
  options: CodexSwapControllerOptions,
): CodexSwapController {
  return createSwapController({
    ...options,
    strategy: codexStrategy,
  }) as CodexSwapController;
}

export function codexSessionsDirFromHome(codexHome: string): string {
  return NodePath.join(codexHome, "sessions");
}
