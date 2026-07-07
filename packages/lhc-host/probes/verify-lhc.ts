// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
/**
 * verify-lhc — read-side verifier for Slice 1.3 live-capture validation.
 *
 * Given a scratch LHC home and one or more t3 thread ids, it:
 *   1. resolves the lineage row (t3 ThreadId -> LHC thread id) from
 *      `<home>/t3code-lhc.sqlite`,
 *   2. reports `inspect.overview` (message byKind, turn open/closed counts,
 *      derivation states) and `inspect.health` (owner counts, failures, queue),
 *   3. lists messages and surfaces: user prompts (host injection + dedup),
 *      assistant text, `assistant_thinking` (reasoning), and tool_result blocks
 *      with the FULL captured byte length,
 *   4. dumps the LHC log (`sdk.logging.query`) with warning/error emphasis.
 *
 * Uses the linked `lhc` SDK directly against the scratch home — no server.
 *
 * Usage:
 *   node --import ./ts-js-resolve-hook.mjs verify-lhc.ts \
 *     --home DIR --thread T3_THREAD_ID [--thread ...] [--out FILE]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { inspect, messages, initLhc, createDeterministicInferenceCallbacks } from "lhc";

interface LineageRow {
  t3ThreadId: string;
  lhcThreadId: string;
  providerKind: string;
  createdAt: string;
}

function readLineage(home: string, t3ThreadId: string): LineageRow | undefined {
  const db = new NodeSqlite.DatabaseSync(NodePath.join(home, "t3code-lhc.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT t3_thread_id, lhc_thread_id, provider_kind, created_at FROM t3_thread_lineage WHERE t3_thread_id = ?",
      )
      .get(t3ThreadId) as
      | { t3_thread_id: string; lhc_thread_id: string; provider_kind: string; created_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      t3ThreadId: row.t3_thread_id,
      lhcThreadId: row.lhc_thread_id,
      providerKind: row.provider_kind,
      createdAt: row.created_at,
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

function collectArgs(): { home: string; threads: string[]; out?: string } {
  const argv = process.argv;
  let home: string | undefined;
  const threads: string[] = [];
  let out: string | undefined;
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--home") home = argv[++i];
    else if (argv[i] === "--thread") threads.push(argv[++i]);
    else if (argv[i] === "--out") out = argv[++i];
  }
  if (!home || threads.length === 0) {
    throw new Error("usage: verify-lhc --home DIR --thread T3_ID [--thread ...] [--out FILE]");
  }
  return { home, threads, ...(out ? { out } : {}) };
}

function blockText(block: { blockType: string; content: Record<string, unknown> }): string {
  const c = block.content;
  if (typeof c.text === "string") return c.text;
  if (typeof c.content === "string") return c.content; // tool_result full content
  return "";
}

async function verifyThread(
  sdk: ReturnType<typeof initLhc>,
  home: string,
  t3ThreadId: string,
): Promise<Record<string, unknown>> {
  const lineage = readLineage(home, t3ThreadId);
  if (!lineage) {
    return { t3ThreadId, lineageFound: false };
  }
  const ref = {
    threadId: lineage.lhcThreadId,
    registryPath: NodePath.join(home, "registry.sqlite"),
  };

  const overview = unwrap(await inspect.overview(ref), "overview");
  const health = unwrap(await inspect.health(ref), "health");
  const messageList = unwrap(await messages.list(ref), "messages.list");
  const logs = unwrap(await sdk.logging.query(ref, {}), "logging.query");

  // Per-message digest.
  const userPrompts: string[] = [];
  const thinkingSamples: string[] = [];
  const assistantSamples: string[] = [];
  const toolResults: Array<{ turnId: string; messageId: string; bytes: number; sample: string }> =
    [];
  const byKind: Record<string, number> = {};
  const turnsSeen = new Set<string>();
  for (const m of messageList) {
    byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
    turnsSeen.add(m.turnId);
    if (m.kind === "user_prompt") userPrompts.push(m.blocks.map(blockText).join(""));
    else if (m.kind === "assistant_thinking") {
      thinkingSamples.push(m.blocks.map(blockText).join("").slice(0, 120));
    } else if (m.kind === "assistant_text") {
      assistantSamples.push(m.blocks.map(blockText).join("").slice(0, 120));
    } else if (m.kind === "tool_result") {
      for (const b of m.blocks) {
        if (b.blockType === "tool_result") {
          const text = blockText(b);
          toolResults.push({
            turnId: m.turnId,
            messageId: m.messageId,
            bytes: Buffer.byteLength(text, "utf8"),
            sample: `${text.slice(0, 40)}…${text.slice(-40)}`,
          });
        }
      }
    }
  }

  // Duplicate user-prompt detection (Codex stream user_message vs host injection).
  const promptCounts: Record<string, number> = {};
  for (const p of userPrompts) promptCounts[p] = (promptCounts[p] ?? 0) + 1;
  const duplicatedPrompts = Object.entries(promptCounts)
    .filter(([, n]) => n > 1)
    .map(([text, n]) => ({ text: text.slice(0, 60), count: n }));

  const warnings = logs.filter((l) => l.level === "warning" || l.level === "error");
  const maxToolBytes = toolResults.reduce((max, t) => Math.max(max, t.bytes), 0);

  // Cross-check the full tool output via messages.show (not just list): show
  // the largest tool_result and confirm the byte length matches list.
  let showCrossCheck: { messageId: string; showBytes: number; matchesList: boolean } | null = null;
  const biggest = toolResults.slice().sort((a, b) => b.bytes - a.bytes)[0];
  if (biggest) {
    const detail = unwrap(await messages.show(ref, biggest.messageId), "messages.show");
    const showBytes = detail.blocks
      .filter((b) => b.blockType === "tool_result")
      .reduce((n, b) => n + Buffer.byteLength(blockText(b), "utf8"), 0);
    showCrossCheck = {
      messageId: biggest.messageId,
      showBytes,
      matchesList: showBytes === biggest.bytes,
    };
  }

  return {
    t3ThreadId,
    lineageFound: true,
    lineage,
    overview: {
      threadId: overview.thread.id,
      events: overview.events.count,
      messagesVisible: overview.messages.visible,
      byKind: overview.messages.byKind,
      turns: overview.turns,
      derivation: overview.derivation,
      chunks: overview.chunks,
    },
    health: {
      owners: health.owners,
      failures: health.failures,
      queue: health.queue,
    },
    messages: {
      total: messageList.length,
      byKind,
      turnsSeen: turnsSeen.size,
      userPromptCount: userPrompts.length,
      userPrompts: userPrompts.map((p) => p.slice(0, 80)),
      duplicatedPrompts,
      thinkingCount: thinkingSamples.length,
      thinkingSamples: thinkingSamples.slice(0, 3),
      assistantCount: assistantSamples.length,
      toolResultCount: toolResults.length,
      toolResults,
      maxToolResultBytes: maxToolBytes,
      showCrossCheck,
    },
    logs: {
      total: logs.length,
      warningCount: warnings.length,
      warnings: warnings.map((w) => ({ level: w.level, message: w.message })),
    },
  };
}

async function main(): Promise<void> {
  const { home, threads, out } = collectArgs();
  const sdk = initLhc({
    mode: "manual",
    inferenceCallbacks: createDeterministicInferenceCallbacks(),
  });
  const results: Array<Record<string, unknown>> = [];
  for (const t3ThreadId of threads) {
    results.push(await verifyThread(sdk, home, t3ThreadId));
  }
  const report = { home, generatedAt: new Date().toISOString(), threads: results };
  const json = JSON.stringify(report, null, 2);
  console.log(json);
  if (out) NodeFS.writeFileSync(out, `${json}\n`);
}

main().then(
  () => setTimeout(() => process.exit(0), 30),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
