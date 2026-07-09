// @effect-diagnostics globalTimers:off globalDate:off
/**
 * Read-side capture verification distilled from probes/verify-lhc.ts.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { inspect, messages } from "lhc";

interface LineageRow {
  readonly t3ThreadId: string;
  readonly lhcThreadId: string;
  readonly providerKind: string;
}

function readLineage(home: string, t3ThreadId: string): LineageRow | undefined {
  const dbPath = NodePath.join(home, "t3code-lhc.sqlite");
  if (!NodeFS.existsSync(dbPath)) return undefined;
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT t3_thread_id, lhc_thread_id, provider_kind FROM t3_thread_lineage WHERE t3_thread_id = ?",
      )
      .get(t3ThreadId) as
      | { t3_thread_id: string; lhc_thread_id: string; provider_kind: string }
      | undefined;
    if (!row) return undefined;
    return {
      t3ThreadId: row.t3_thread_id,
      lhcThreadId: row.lhc_thread_id,
      providerKind: row.provider_kind,
    };
  } finally {
    db.close();
  }
}

function unwrap<T>(
  result: { ok: true; value: T } | { ok: false; error: unknown },
  label: string,
): T {
  if (!result.ok) throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function blockText(block: { blockType: string; content: Record<string, unknown> }): string {
  const c = block.content;
  if (typeof c.text === "string") return c.text;
  if (typeof c.content === "string") return c.content;
  return "";
}

export interface CaptureVerifyResult {
  readonly lineageFound: boolean;
  readonly lineage?: LineageRow;
  readonly userPromptCount: number;
  readonly duplicatedPromptCount: number;
  readonly maxToolResultBytes: number;
  readonly turnsClosed: number;
  readonly turnsOpen: number;
  readonly showCrossCheckMatches: boolean | null;
}

export async function verifyCapture(
  home: string,
  t3ThreadId: string,
): Promise<CaptureVerifyResult> {
  const lineage = readLineage(home, t3ThreadId);
  if (!lineage) {
    return {
      lineageFound: false,
      userPromptCount: 0,
      duplicatedPromptCount: 0,
      maxToolResultBytes: 0,
      turnsClosed: 0,
      turnsOpen: 0,
      showCrossCheckMatches: null,
    };
  }

  const ref = {
    threadId: lineage.lhcThreadId,
    registryPath: NodePath.join(home, "registry.sqlite"),
  };

  const overview = unwrap(await inspect.overview(ref), "overview");
  const messageList = unwrap(await messages.list(ref), "messages.list");

  const userPrompts: string[] = [];
  const toolResults: Array<{ messageId: string; bytes: number }> = [];
  for (const m of messageList) {
    if (m.kind === "user_prompt") userPrompts.push(m.blocks.map(blockText).join(""));
    if (m.kind === "tool_result") {
      for (const b of m.blocks) {
        if (b.blockType === "tool_result") {
          const text = blockText(b);
          toolResults.push({ messageId: m.messageId, bytes: Buffer.byteLength(text, "utf8") });
        }
      }
    }
  }

  const promptCounts: Record<string, number> = {};
  for (const p of userPrompts) promptCounts[p] = (promptCounts[p] ?? 0) + 1;
  const duplicatedPromptCount = Object.values(promptCounts).filter((n) => n > 1).length;

  const maxToolResultBytes = toolResults.reduce((max, t) => Math.max(max, t.bytes), 0);

  let showCrossCheckMatches: boolean | null = null;
  const biggest = toolResults.slice().sort((a, b) => b.bytes - a.bytes)[0];
  if (biggest) {
    const detail = unwrap(await messages.show(ref, biggest.messageId), "messages.show");
    const showBytes = detail.blocks
      .filter((b) => b.blockType === "tool_result")
      .reduce((n, b) => n + Buffer.byteLength(blockText(b), "utf8"), 0);
    showCrossCheckMatches = showBytes === biggest.bytes;
  }

  return {
    lineageFound: true,
    lineage,
    userPromptCount: userPrompts.length,
    duplicatedPromptCount,
    maxToolResultBytes,
    turnsClosed: overview.turns.closed,
    turnsOpen: overview.turns.open,
    showCrossCheckMatches,
  };
}
