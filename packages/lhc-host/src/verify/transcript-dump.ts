// Canonical transcript dumps — the fidelity-certification harness (ported
// from cc-lhc, which ported the approach from pi-lhc's export serializer).
// Three sources, one format:
//
//   dumpSessionThreadView    — what LHC serves (both rebuilds' input)
//   dumpClaudeRolloutLines   — a Claude Code rollout file, normalized
//   dumpCodexRolloutLines    — a codex rollout file, normalized
//
// Because the rebuilds emit native records, a faithful swap makes the dumps
// line up entry-for-entry: diff a pre-compact rollout dump against a
// post-compact one and the tail must match exactly, with only the banded
// head replaced by [context · band] entries (plus the trailing swap
// receipt). The dump format itself uses bracket labels — that is fine HERE
// because these files are diff artifacts for humans, never served to a
// model.
//
// Determinism rules: tool arguments serialize with recursively sorted keys
// (structural equality → byte equality; codex `arguments` strings are
// parsed first so both lanes normalize identically); harness bookkeeping
// (meta lines, events, session_meta, the synthetic resume line) never
// appears, so two dumps differ only where transcript content differs.

import type { SessionThreadView } from "lhc";

import type {
  RolloutLineItem as ClaudeRolloutLineItem,
  ContentBlock,
} from "../claude-swap/types.ts";
import type { RolloutLineItem as CodexRolloutLineItem } from "../codex-swap/types.ts";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
    return sorted;
  }
  return value;
}

/** Stable-sorted-key JSON: two structurally equal payloads compare equal. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null";
}

interface DumpEntry {
  label: string;
  body: string;
}

function formatEntries(entries: readonly DumpEntry[]): string {
  if (entries.length === 0) return "";
  return `${entries
    .map((entry) => (entry.body === "" ? entry.label : `${entry.label}\n${entry.body}`))
    .join("\n\n")}\n`;
}

function toolCallLabel(name: string, id: string): string {
  return `[tool call · ${name} · ${id}]`;
}

function toolResultLabel(id: string, isError: boolean): string {
  return `[tool result · ${id}${isError ? " · error" : ""}]`;
}

/** Canonical dump of the served thread view — the rebuilds' exact input. */
export function dumpSessionThreadView(view: SessionThreadView): string {
  const out: DumpEntry[] = [];
  for (const entry of view.entries) {
    if ("kind" in entry) {
      if (entry.kind === "model_change") {
        out.push({ label: `[model change · ${entry.provider}/${entry.modelId}]`, body: "" });
      } else {
        out.push({ label: `[thinking level change · ${entry.level}]`, body: "" });
      }
      continue;
    }
    if (entry.role === "user") {
      out.push({ label: "[user]", body: entry.content });
      continue;
    }
    if (entry.role === "toolResult") {
      out.push({
        label: toolResultLabel(entry.toolCallId, entry.isError === true),
        body: entry.content,
      });
      continue;
    }
    for (const part of entry.content) {
      if (part.type === "text" && part.text !== undefined && part.text !== "") {
        out.push({ label: "[assistant]", body: part.text });
      } else if (part.type === "thinking" && part.thinking !== undefined && part.thinking !== "") {
        out.push({ label: "[assistant thinking]", body: part.thinking });
      } else if (part.type === "toolCall") {
        out.push({
          label: toolCallLabel(part.toolName ?? "tool", part.toolCallId ?? ""),
          body: stableJson(part.arguments ?? {}),
        });
      }
    }
  }
  return formatEntries(out);
}

// ── Claude Code rollout dump ────────────────────────────────────────────────

/** Content markers Claude Code uses for harness bookkeeping inside user lines. */
const CLAUDE_META_MARKERS = [
  "<local-command-caveat>",
  "<command-name>",
  "<local-command-stdout>",
] as const;

const SYNTHETIC_MODEL = "<synthetic>";
const SYNTHETIC_NO_RESPONSE_TEXT = "No response requested.";

function isClaudeMetaUserContent(content: string): boolean {
  return CLAUDE_META_MARKERS.some((marker) => content.includes(marker));
}

function isClaudeSyntheticNoResponse(item: ClaudeRolloutLineItem): boolean {
  const message = item.message;
  if (message === undefined || message.model !== SYNTHETIC_MODEL) return false;
  const content = message.content;
  if (!Array.isArray(content) || content.length !== 1) return false;
  const block = content[0]!;
  return block.type === "text" && block.text === SYNTHETIC_NO_RESPONSE_TEXT;
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content) ?? String(content);
  } catch {
    return String(content);
  }
}

function dumpClaudeAssistantBlock(block: ContentBlock, out: DumpEntry[]): void {
  if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
    out.push({ label: "[assistant]", body: block.text });
  } else if (
    block.type === "thinking" &&
    typeof block.thinking === "string" &&
    block.thinking !== ""
  ) {
    out.push({ label: "[assistant thinking]", body: block.thinking });
  } else if (block.type === "tool_use") {
    const name = typeof block.name === "string" ? block.name : "tool";
    const id = typeof block.id === "string" ? block.id : "";
    out.push({ label: toolCallLabel(name, id), body: stableJson(block.input ?? {}) });
  }
}

function dumpClaudeUserBlock(block: ContentBlock, out: DumpEntry[]): void {
  if (block.type === "tool_result") {
    const id = typeof block.tool_use_id === "string" ? block.tool_use_id : "";
    out.push({
      label: toolResultLabel(id, block.is_error === true),
      body: stringifyToolResultContent(block.content),
    });
  } else if (block.type === "text" && typeof block.text === "string") {
    out.push({ label: "[user]", body: block.text });
  } else {
    // images and other rich blocks: presence marker only
    out.push({ label: `[${block.type}]`, body: "" });
  }
}

/** Canonical dump of parsed Claude Code rollout lines. Skips what intake skips. */
export function dumpClaudeRolloutLines(items: readonly ClaudeRolloutLineItem[]): string {
  const out: DumpEntry[] = [];
  for (const item of items) {
    if (item.isSidechain === true) continue;
    if (item.isMeta === true) continue;
    if (item.type !== "user" && item.type !== "assistant") continue;
    if (isClaudeSyntheticNoResponse(item)) continue;
    const content = item.message?.content;
    if (content === undefined) continue;
    if (item.type === "user") {
      if (typeof content === "string") {
        if (isClaudeMetaUserContent(content)) continue;
        out.push({ label: "[user]", body: content });
      } else if (Array.isArray(content)) {
        for (const block of content) dumpClaudeUserBlock(block, out);
      }
      continue;
    }
    if (typeof content === "string") {
      out.push({ label: "[assistant]", body: content });
    } else if (Array.isArray(content)) {
      for (const block of content) dumpClaudeAssistantBlock(block, out);
    }
  }
  return formatEntries(out);
}

// ── codex rollout dump ──────────────────────────────────────────────────────

function codexMessageText(blocks: unknown, wanted: string): string[] {
  if (!Array.isArray(blocks)) return [];
  const texts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record.type === wanted && typeof record.text === "string" && record.text !== "") {
      texts.push(record.text);
    }
  }
  return texts;
}

/** codex `arguments` is a JSON string — parse before stable-serializing so both lanes normalize identically. */
function codexArgumentsBody(raw: unknown): string {
  if (typeof raw !== "string") return stableJson(raw ?? {});
  try {
    return stableJson(JSON.parse(raw));
  } catch {
    return raw;
  }
}

/**
 * Canonical dump of parsed codex rollout lines. `session_meta` and
 * `event_msg` lines are skipped (UI-replay duplicates of response_items);
 * only `response_item` payloads carry transcript content.
 */
export function dumpCodexRolloutLines(items: readonly CodexRolloutLineItem[]): string {
  const out: DumpEntry[] = [];
  for (const item of items) {
    if (item.type !== "response_item") continue;
    const payload = item.payload;
    if (typeof payload !== "object" || payload === null) continue;
    const kind = payload.type;
    if (kind === "message") {
      if (payload.role === "user") {
        for (const text of codexMessageText(payload.content, "input_text")) {
          out.push({ label: "[user]", body: text });
        }
      } else if (payload.role === "assistant") {
        for (const text of codexMessageText(payload.content, "output_text")) {
          out.push({ label: "[assistant]", body: text });
        }
      }
      continue;
    }
    if (kind === "reasoning") {
      const texts = [
        ...codexMessageText(payload.content, "reasoning_text"),
        ...codexMessageText(payload.summary, "summary_text"),
      ];
      if (texts.length > 0) out.push({ label: "[assistant thinking]", body: texts.join("\n\n") });
      continue;
    }
    if (kind === "function_call" || kind === "custom_tool_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const id = typeof payload.call_id === "string" ? payload.call_id : "";
      out.push({ label: toolCallLabel(name, id), body: codexArgumentsBody(payload.arguments) });
      continue;
    }
    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const id = typeof payload.call_id === "string" ? payload.call_id : "";
      const isError = payload.is_error === true;
      out.push({
        label: toolResultLabel(id, isError),
        body: stringifyToolResultContent(payload.output),
      });
      continue;
    }
  }
  return formatEntries(out);
}

/** Parse rollout JSONL content into line items, skipping unparseable lines. */
export function parseRolloutContent<T>(content: string): T[] {
  const items: T[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      // unparseable lines carry no transcript content worth diffing
    }
  }
  return items;
}
