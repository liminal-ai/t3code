// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionThreadView } from "lhc";

import {
  buildRolloutLines,
  formatSwapReceipt,
  receiptRolloutLines,
  serializeRolloutLines,
  sourceMetaFromContent,
  type RebuildSourceMeta,
  type RebuiltRolloutLine,
} from "./rebuild.ts";

export interface WriteRebuiltRolloutInput {
  view: SessionThreadView;
  cwd: string;
  /** Absolute path to per-instance CODEX_HOME (rollout lands under `<codexHome>/sessions/`). */
  codexHome: string;
  /** Source rollout to copy session_meta provenance from (cli_version, base_instructions, forked_from_id). */
  sourceRolloutPath?: string;
  newSessionId?: string;
  clock?: () => Date;
  readSourceFn?: (path: string) => Promise<string>;
  /** When set, append the swap receipt as trailing runtime-note lines. */
  swapReceipt?: {
    oldSessionId: string;
    threadId: string;
    op: string;
    tokensBefore?: number;
    tokensAfter?: number;
  };
}

export interface WriteRebuiltRolloutResult {
  sessionId: string;
  rolloutPath: string;
  lineCount: number;
  /** Total lines the handoff capture expects to re-intake from the written file. */
  expectedReintakeLines: number;
  /**
   * Lines the handoff capture must hard-skip as replayed served-view content.
   * The trailing swap-receipt lines are NOT among them: the receipt is
   * genuinely new history that must map into the thread record (the
   * response_item as runtime_note; its event_msg twin is skip-counted) so
   * later rebuilds re-serve it.
   */
  replayedPrefixLines: number;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `<codexHome>/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDTHH-MM-SS-<id>.jsonl`, LOCAL time like codex. */
export function rebuiltRolloutPath(codexHome: string, sessionId: string, when: Date): string {
  const year = String(when.getFullYear());
  const month = pad2(when.getMonth() + 1);
  const day = pad2(when.getDate());
  const stamp = `${year}-${month}-${day}T${pad2(when.getHours())}-${pad2(when.getMinutes())}-${pad2(when.getSeconds())}`;
  return NodePath.join(
    codexHome,
    "sessions",
    year,
    month,
    day,
    `rollout-${stamp}-${sessionId}.jsonl`,
  );
}

function sessionIdFromRolloutFilename(rolloutPath: string): string {
  const base = NodePath.basename(rolloutPath, ".jsonl");
  const match = base.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/);
  if (match?.[1] === undefined) {
    throw new Error(`t3code-lhc: rollout filename does not match expected pattern: ${base}`);
  }
  return match[1];
}

/**
 * t3code invariant (codex-swap probe): filename suffix, session_meta.payload.id,
 * and session_meta.payload.session_id must all match — app-server accepts mismatches
 * but returns the metadata id, which would poison the persisted cursor.
 */
export function assertRolloutIdentityInvariant(
  sessionId: string,
  lines: readonly RebuiltRolloutLine[],
  rolloutPath: string,
): void {
  const filenameId = sessionIdFromRolloutFilename(rolloutPath);
  if (filenameId !== sessionId) {
    throw new Error(
      `t3code-lhc: rollout filename id ${filenameId} does not match session id ${sessionId}`,
    );
  }

  const meta = lines[0];
  if (meta?.kind !== "session_meta" || meta.line.type !== "session_meta") {
    throw new Error("t3code-lhc: rebuilt rollout must start with session_meta");
  }

  const payload = meta.line.payload;
  const metaId = payload.id;
  const metaSessionId = payload.session_id;
  if (typeof metaId !== "string" || metaId !== sessionId) {
    throw new Error(
      `t3code-lhc: session_meta.payload.id ${String(metaId)} does not match session id ${sessionId}`,
    );
  }
  if (typeof metaSessionId !== "string" || metaSessionId !== sessionId) {
    throw new Error(
      `t3code-lhc: session_meta.payload.session_id ${String(metaSessionId)} does not match session id ${sessionId}`,
    );
  }
}

async function writeFileFsyncAtomic(path: string, content: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  const tempPath = NodePath.join(NodePath.dirname(path), `.${NodeCrypto.randomUUID()}.tmp`);
  const handle = await NodeFSP.open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(tempPath, path);
}

/**
 * Rebuild a codex rollout from a thread view and write it where codex expects
 * sessions. File placement alone registers the session (codex's sqlite catalog
 * backfills on resume — proven live 2026-07-07); no sqlite writes, no
 * session_index write, and the original rollout is never touched.
 */
export async function writeRebuiltRollout(
  input: WriteRebuiltRolloutInput,
): Promise<WriteRebuiltRolloutResult> {
  const newSessionId = input.newSessionId ?? NodeCrypto.randomUUID();
  const clock = input.clock ?? ((): Date => new Date());
  const readSource = input.readSourceFn ?? ((path: string) => NodeFSP.readFile(path, "utf8"));

  let sourceMeta: RebuildSourceMeta | undefined;
  if (input.sourceRolloutPath !== undefined) {
    try {
      sourceMeta = sourceMetaFromContent(await readSource(input.sourceRolloutPath));
    } catch {
      sourceMeta = undefined;
    }
  }

  const when = clock();
  const lines = buildRolloutLines({
    entries: input.view.entries,
    newSessionId,
    cwd: input.cwd,
    ...(sourceMeta !== undefined ? { sourceMeta } : {}),
    clock: () => when,
  });
  const replayedPrefixLines = lines.length;

  if (input.swapReceipt !== undefined) {
    const receipt = formatSwapReceipt({
      oldSessionId: input.swapReceipt.oldSessionId,
      newSessionId,
      threadId: input.swapReceipt.threadId,
      op: input.swapReceipt.op,
      ...(input.swapReceipt.tokensBefore !== undefined
        ? { tokensBefore: input.swapReceipt.tokensBefore }
        : {}),
      ...(input.swapReceipt.tokensAfter !== undefined
        ? { tokensAfter: input.swapReceipt.tokensAfter }
        : {}),
      expectedReplayLines: replayedPrefixLines,
    });
    lines.push(
      ...receiptRolloutLines(receipt, new Date(when.getTime() + lines.length).toISOString()),
    );
  }

  const rolloutPath = rebuiltRolloutPath(input.codexHome, newSessionId, when);
  assertRolloutIdentityInvariant(newSessionId, lines, rolloutPath);
  await writeFileFsyncAtomic(rolloutPath, serializeRolloutLines(lines));

  return {
    sessionId: newSessionId,
    rolloutPath,
    lineCount: lines.length,
    expectedReintakeLines: lines.length,
    replayedPrefixLines,
  };
}
