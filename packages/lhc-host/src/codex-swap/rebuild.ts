// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import type { SessionAssistantPart, SessionThreadViewEntry, SessionThreadViewMessage } from "lhc";

import type { CodexRolloutLine } from "./types.ts";

export interface RebuiltRolloutLine {
  line: CodexRolloutLine;
  kind: "session_meta" | "user" | "assistant" | "event" | "receipt";
}

/** Fields copied from the SOURCE rollout's session_meta into the rebuilt one. */
export interface RebuildSourceMeta {
  sourceSessionId?: string;
  cliVersion?: string;
  baseInstructions?: unknown;
}

export interface RebuildRolloutInput {
  entries: readonly SessionThreadViewEntry[];
  newSessionId: string;
  cwd: string;
  sourceMeta?: RebuildSourceMeta;
  /** Injectable clock; line timestamps are strictly increasing from this base. */
  clock?: () => Date;
}

export interface SwapReceiptInfo {
  oldSessionId: string;
  newSessionId: string;
  threadId: string;
  op: string;
  tokensBefore?: number;
  tokensAfter?: number;
  expectedReplayLines: number;
}

const RUNTIME_NOTE_LABEL = "[runtime note]";

function isMessageEntry(entry: SessionThreadViewEntry): entry is SessionThreadViewMessage {
  return "role" in entry;
}

function isRuntimeNoteContent(text: string): boolean {
  return text.trimStart().startsWith(RUNTIME_NOTE_LABEL);
}

/**
 * Native codex response_item for one assistant part, or null for an empty
 * part. Bracket-label text renderings of tool activity are banned from the
 * tail (they taught the model to emit "[tool …]" markers before real calls —
 * the echo failure mode); they belong only to the compacted bands.
 *
 * Shapes match what the intake mapper parses back (codex-lhc map.ts) and the
 * codex rollout format: `function_call` carries `arguments` as a JSON STRING
 * plus `call_id`; thinking becomes a `reasoning` item with a summary_text
 * block (the record has no encrypted_content to restore).
 */
function assistantPartResponseItem(
  part: SessionAssistantPart,
  timestamp: string,
): CodexRolloutLine | null {
  if (part.type === "text" && part.text !== undefined && part.text !== "") {
    return assistantResponseItem(part.text, timestamp);
  }
  if (part.type === "thinking" && part.thinking !== undefined && part.thinking !== "") {
    return {
      timestamp,
      type: "response_item",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: part.thinking }] },
    };
  }
  if (part.type === "toolCall") {
    return {
      timestamp,
      type: "response_item",
      payload: {
        type: "function_call",
        name: part.toolName ?? "tool",
        arguments: JSON.stringify(part.arguments ?? {}),
        call_id: part.toolCallId ?? "",
      },
    };
  }
  return null;
}

function userResponseItem(text: string, timestamp: string): CodexRolloutLine {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text }] },
  };
}

function assistantResponseItem(text: string, timestamp: string): CodexRolloutLine {
  return {
    timestamp,
    type: "response_item",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  };
}

function userMessageEvent(text: string, timestamp: string): CodexRolloutLine {
  return {
    timestamp,
    type: "event_msg",
    payload: {
      type: "user_message",
      message: text,
      images: [],
      local_images: [],
      text_elements: [],
    },
  };
}

function agentMessageEvent(text: string, timestamp: string): CodexRolloutLine {
  return {
    timestamp,
    type: "event_msg",
    payload: { type: "agent_message", message: text, phase: "final_answer", memory_citation: null },
  };
}

function sessionMetaLine(input: RebuildRolloutInput, timestamp: string): CodexRolloutLine {
  const payload: Record<string, unknown> = {
    session_id: input.newSessionId,
    id: input.newSessionId,
    timestamp,
    cwd: input.cwd,
    originator: "codex-lhc",
    source: "exec",
    thread_source: "user",
    model_provider: "openai",
  };
  const meta = input.sourceMeta;
  if (meta?.cliVersion !== undefined) payload.cli_version = meta.cliVersion;
  if (meta?.baseInstructions !== undefined) payload.base_instructions = meta.baseInstructions;
  if (meta?.sourceSessionId !== undefined) payload.forked_from_id = meta.sourceSessionId;
  return { timestamp, type: "session_meta", payload };
}

/**
 * The swap receipt shown after prune/compact. It rides the rebuilt rollout as
 * a trailing `[runtime note]` user line: codex re-serves it as visible
 * history, and the intake mapper re-classifies it as runtime_note on re-tail
 * so it stays out of the user-prompt lane.
 */
export function formatSwapReceipt(info: SwapReceiptInfo): string {
  const tokens =
    info.tokensBefore !== undefined && info.tokensAfter !== undefined
      ? `; serving tokens ${info.tokensBefore} -> ${info.tokensAfter}`
      : "";
  return (
    `codex-lhc ${info.op}: thread ${info.threadId}${tokens}; ` +
    `session ${info.oldSessionId} preserved; resumed as ${info.newSessionId} ` +
    `(expect ~${info.expectedReplayLines} replayed lines)`
  );
}

/** The two trailing receipt lines: a user response_item plus its replay event. */
export function receiptRolloutLines(receiptText: string, timestamp: string): RebuiltRolloutLine[] {
  const text = `${RUNTIME_NOTE_LABEL} ${receiptText}`;
  return [
    { line: userResponseItem(text, timestamp), kind: "receipt" },
    { line: userMessageEvent(text, timestamp), kind: "receipt" },
  ];
}

/**
 * Map assembled thread-view entries to codex rollout line objects.
 *
 * The tail re-emits NATIVE records: assistant text as message/output_text,
 * thinking as `reasoning` items, tool calls as `function_call` and results
 * as `function_call_output`, paired verbatim by `call_id` (the view carries
 * both sides from the record, so the rebuilt stream never contains unpaired
 * or fabricated tool records — the pairing guarantee the earlier
 * message-only design bought at the cost of bracket-label text the model
 * then imitated). Only text parts get an `agent_message` UI-replay event;
 * tool records are context, not chat lines. model_change /
 * thinking_level_change entries are dropped (codex carries the model in
 * turn_context lines, not per-item — known-lossy).
 */
export function buildRolloutLines(input: RebuildRolloutInput): RebuiltRolloutLine[] {
  const clock = input.clock ?? ((): Date => new Date());
  const base = clock().getTime();
  let tick = 0;
  const nextTimestamp = (): string => new Date(base + tick++).toISOString();

  const rebuilt: RebuiltRolloutLine[] = [];
  rebuilt.push({ line: sessionMetaLine(input, nextTimestamp()), kind: "session_meta" });

  let emittedUserEvent = false;
  for (const entry of input.entries) {
    if (!isMessageEntry(entry)) continue;

    if (entry.role === "user") {
      rebuilt.push({ line: userResponseItem(entry.content, nextTimestamp()), kind: "user" });
      if (!emittedUserEvent && !isRuntimeNoteContent(entry.content)) {
        rebuilt.push({ line: userMessageEvent(entry.content, nextTimestamp()), kind: "event" });
        emittedUserEvent = true;
      }
      continue;
    }

    if (entry.role === "toolResult") {
      rebuilt.push({
        line: {
          timestamp: nextTimestamp(),
          type: "response_item",
          payload: {
            type: "function_call_output",
            call_id: entry.toolCallId,
            output: entry.content,
            ...(entry.isError === true ? { is_error: true } : {}),
          },
        },
        kind: "user",
      });
      continue;
    }

    if (entry.role === "assistant") {
      for (const part of entry.content) {
        const line = assistantPartResponseItem(part, nextTimestamp());
        if (line === null) continue;
        rebuilt.push({ line, kind: "assistant" });
        if (part.type === "text" && part.text !== undefined && part.text !== "") {
          rebuilt.push({ line: agentMessageEvent(part.text, nextTimestamp()), kind: "event" });
        }
      }
    }
  }

  return rebuilt;
}

export function serializeRolloutLines(lines: readonly RebuiltRolloutLine[]): string {
  return (
    lines.map((entry) => JSON.stringify(entry.line)).join("\n") + (lines.length > 0 ? "\n" : "")
  );
}

/**
 * Extract the fields a rebuild copies from a source rollout's first
 * session_meta line. Tolerant: garbage or a missing meta line yields {}.
 */
export function sourceMetaFromContent(content: string): RebuildSourceMeta {
  for (const raw of content.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    if (record.type !== "session_meta") continue;
    const payload = record.payload;
    if (typeof payload !== "object" || payload === null) return {};
    const fields = payload as Record<string, unknown>;
    const meta: RebuildSourceMeta = {};
    const sourceId = fields.session_id ?? fields.id;
    if (typeof sourceId === "string") meta.sourceSessionId = sourceId;
    if (typeof fields.cli_version === "string") meta.cliVersion = fields.cli_version;
    if (fields.base_instructions !== undefined) meta.baseInstructions = fields.base_instructions;
    return meta;
  }
  return {};
}
