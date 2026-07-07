import { isToolLifecycleItemType, TOOL_LIFECYCLE_ITEM_TYPES } from "@t3tools/contracts";
import type { MessageEventInput } from "lhc";

import { incrementCounter, type CaptureMapResult } from "./stats.ts";
import { applyTurnAccumulatorInPlace, type TurnAccumulatorState } from "./turn-accumulator.ts";

const HARNESS = "t3code";
type ToolLifecycleItemType = (typeof TOOL_LIFECYCLE_ITEM_TYPES)[number];

interface ItemLifecyclePayload {
  itemType: string;
  status?: string;
  title?: string;
  detail?: string;
  data?: unknown;
}

type RuntimeEventLike = {
  type: string;
  eventId: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  providerRefs?: { providerItemId?: string };
  payload: unknown;
};

interface MapOptions {
  turnAccumulator?: TurnAccumulatorState;
}

interface ToolParts {
  toolName: string;
  args: Record<string, unknown>;
  content: string;
  isError?: boolean;
}

export function userPromptKey(threadId: string, turnId: string): string {
  // User prompt keys are turn-scoped: a second user_message with the same turnId
  // intentionally collapses by key, and LHC key-wins dedupe drops its content.
  return `t3lhc:${threadId}:turn:${turnId}:user_prompt`;
}

export function itemEventKey(
  threadId: string,
  itemId: string,
  kind: MessageEventInput["eventKind"],
): string {
  return `t3lhc:${threadId}:${itemId}:${kind}`;
}

export function runtimeEventKey(
  threadId: string,
  eventId: string,
  kind: MessageEventInput["eventKind"],
): string {
  // Event-id keys are stable for persisted stream re-tails, not hypothetical
  // provider re-derivations that would mint different runtime event ids.
  return `t3lhc:${threadId}:${eventId}:${kind}`;
}

export function userPromptEvent(threadId: string, turnId: string, text: string): MessageEventInput {
  return {
    eventKind: "user_prompt",
    idempotencyKey: userPromptKey(threadId, turnId),
    actor: "user",
    harness: HARNESS,
    payload: { text },
  };
}

export function mapProviderRuntimeEvent(
  input: RuntimeEventLike | unknown,
  options: MapOptions = {},
): CaptureMapResult {
  const skips: Record<string, number> = {};

  try {
    if (!isRecord(input) || typeof input.type !== "string") return malformed(skips);
    if (typeof input.threadId !== "string" || typeof input.eventId !== "string")
      return malformed(skips);
    const event = input as RuntimeEventLike;

    switch (event.type) {
      case "content.delta":
        return { events: [], skips };
      case "item.completed":
        return mapCompletedItem(event, skips);
      case "turn.started":
        if (options.turnAccumulator !== undefined) {
          applyTurnAccumulatorInPlace(options.turnAccumulator, event);
        }
        return { events: [], skips };
      case "turn.completed":
        return mapTurnCompleted(event, skips, options.turnAccumulator);
      case "turn.aborted":
        return mapTurnAborted(event, skips, options.turnAccumulator);
      case "model.rerouted":
        return mapModelRerouted(event, skips);
      default:
        incrementCounter(skips, event.type);
        return { events: [], skips };
    }
  } catch {
    return malformed(skips);
  }
}

function mapCompletedItem(
  event: RuntimeEventLike,
  skips: Record<string, number>,
): CaptureMapResult {
  const payload = event.payload;
  if (!isItemPayload(payload)) return malformed(skips);

  const itemType = payload.itemType;
  if (itemType === "user_message") {
    if (typeof event.turnId !== "string") {
      incrementCounter(skips, "user_message_no_turn");
      return { events: [], skips };
    }
    const text = textFromUserMessage(payload);
    if (text === null) return malformed(skips);
    return { events: [userPromptEvent(event.threadId, event.turnId, text)], skips };
  }

  if (itemType === "assistant_message") {
    const itemId = itemIdFor(event);
    const text = textFromAssistantMessage(payload);
    if (itemId === null || text === null) return malformed(skips);
    return {
      events: [
        textEvent(
          "assistant_text",
          text,
          "assistant",
          itemEventKey(event.threadId, itemId, "assistant_text"),
        ),
      ],
      skips,
    };
  }

  if (itemType === "reasoning") {
    const itemId = itemIdFor(event);
    const text = textFromReasoning(payload);
    if (itemId === null || text === null) return malformed(skips);
    return {
      events: [
        textEvent(
          "assistant_thinking",
          text,
          "assistant",
          itemEventKey(event.threadId, itemId, "assistant_thinking"),
        ),
      ],
      skips,
    };
  }

  if (isToolLifecycleItemType(itemType)) {
    const itemId = itemIdFor(event);
    if (itemId === null) return malformed(skips);
    const tool = toolParts(itemType, payload);
    if (tool === null) return malformed(skips);
    return {
      events: [
        {
          eventKind: "tool_call",
          idempotencyKey: itemEventKey(event.threadId, itemId, "tool_call"),
          actor: "assistant",
          harness: HARNESS,
          payload: { toolCallId: itemId, toolName: tool.toolName, arguments: tool.args },
        },
        {
          eventKind: "tool_result",
          idempotencyKey: itemEventKey(event.threadId, itemId, "tool_result"),
          actor: "tool",
          harness: HARNESS,
          payload: {
            toolCallId: itemId,
            content: tool.content,
            ...(tool.isError === undefined ? {} : { isError: tool.isError }),
          },
        },
      ],
      skips,
    };
  }

  if (itemType === "context_compaction") {
    const itemId = itemIdFor(event);
    const key =
      itemId === null
        ? runtimeEventKey(event.threadId, event.eventId, "runtime_note")
        : itemEventKey(event.threadId, itemId, "runtime_note");
    incrementCounter(skips, "context_compaction");
    return {
      events: [textEvent("runtime_note", "provider-native compaction", "system", key)],
      skips,
    };
  }

  incrementCounter(skips, `item.${itemType}`);
  return { events: [], skips };
}

function mapModelRerouted(
  event: RuntimeEventLike,
  skips: Record<string, number>,
): CaptureMapResult {
  const payload = event.payload;
  if (
    !isRecord(payload) ||
    typeof payload.fromModel !== "string" ||
    typeof payload.toModel !== "string"
  ) {
    return malformed(skips);
  }
  return {
    events: [
      {
        eventKind: "model_change",
        idempotencyKey: runtimeEventKey(event.threadId, event.eventId, "model_change"),
        actor: "system",
        harness: HARNESS,
        payload: { previousModel: payload.fromModel, newModel: payload.toModel },
      },
    ],
    skips,
  };
}

function mapTurnCompleted(
  event: RuntimeEventLike,
  skips: Record<string, number>,
  accumulator: TurnAccumulatorState | undefined,
): CaptureMapResult {
  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.state !== "string") return malformed(skips);
  if (accumulator !== undefined) applyTurnAccumulatorInPlace(accumulator, event);

  const events: MessageEventInput[] = [];
  if (payload.state !== "completed") {
    const error = typeof payload.errorMessage === "string" ? `: ${payload.errorMessage}` : "";
    events.push(
      textEvent(
        "runtime_note",
        `turn completed with state ${payload.state}${error}`,
        "system",
        runtimeEventKey(event.threadId, event.eventId, "runtime_note"),
      ),
    );
  }
  events.push(turnEndEvent(event));
  return { events, skips };
}

function mapTurnAborted(
  event: RuntimeEventLike,
  skips: Record<string, number>,
  accumulator: TurnAccumulatorState | undefined,
): CaptureMapResult {
  const payload = event.payload;
  if (!isRecord(payload) || typeof payload.reason !== "string") return malformed(skips);
  if (accumulator !== undefined) applyTurnAccumulatorInPlace(accumulator, event);
  return {
    events: [
      textEvent(
        "runtime_note",
        `turn aborted: ${payload.reason}`,
        "system",
        runtimeEventKey(event.threadId, event.eventId, "runtime_note"),
      ),
      turnEndEvent(event),
    ],
    skips,
  };
}

function turnEndEvent(event: RuntimeEventLike): MessageEventInput {
  return {
    eventKind: "turn_end",
    idempotencyKey: runtimeEventKey(event.threadId, event.eventId, "turn_end"),
    actor: "system",
    harness: HARNESS,
    payload: {},
  };
}

function textEvent(
  kind: "assistant_text" | "assistant_thinking" | "runtime_note",
  text: string,
  actor: "assistant" | "system",
  idempotencyKey: string,
): MessageEventInput {
  return { eventKind: kind, idempotencyKey, actor, harness: HARNESS, payload: { text } };
}

function itemIdFor(event: RuntimeEventLike): string | null {
  if (typeof event.itemId === "string" && event.itemId !== "") return event.itemId;
  const providerItemId = event.providerRefs?.providerItemId;
  if (typeof providerItemId === "string" && providerItemId !== "") return providerItemId;
  return null;
}

function textFromUserMessage(payload: ItemLifecyclePayload): string | null {
  const detail = stringOrNull(payload.detail);
  if (detail !== null) return detail;

  const data = payload.data;
  if (!isRecord(data)) return null;
  const item = data.item;
  if (!isRecord(item)) return null;
  const content = item.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const parts = content.flatMap((block) => {
    if (!isRecord(block)) return [];
    return typeof block.text === "string" ? [block.text] : [];
  });
  return parts.length === 0 ? null : parts.join("");
}

function textFromAssistantMessage(payload: ItemLifecyclePayload): string | null {
  const detail = stringOrNull(payload.detail);
  if (detail !== null) return detail;

  const data = payload.data;
  if (isRecord(data)) {
    const item = data.item;
    if (isRecord(item)) {
      const text = stringOrNull(item.text);
      if (text !== null) return text;
    }
    const text = stringOrNull(data.text);
    if (text !== null) return text;
  }
  return null;
}

function textFromReasoning(payload: ItemLifecyclePayload): string | null {
  const detail = stringOrNull(payload.detail);
  if (detail !== null) return detail;

  const data = payload.data;
  if (!isRecord(data)) return null;
  for (const key of ["thinking", "reasoning", "text", "summary"]) {
    const value = stringOrNull(data[key]);
    if (value !== null) return value;
  }
  const item = data.item;
  if (isRecord(item)) {
    for (const key of ["thinking", "reasoning", "text"]) {
      const value = stringOrNull(item[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function toolParts(
  itemType: ToolLifecycleItemType,
  payload: ItemLifecyclePayload,
): ToolParts | null {
  const data = payload.data;
  if (!isRecord(data)) return null;

  const item = isRecord(data.item) ? data.item : undefined;
  const result = isRecord(data.result) ? data.result : undefined;

  const toolName =
    stringOrNull(data.toolName) ??
    stringOrNull(item?.toolName) ??
    stringOrNull(item?.name) ??
    stringOrNull(result?.name) ??
    toolNameForItemType(itemType);

  const args = argsFromToolData(data, item);
  const content = appendOutcome(
    outputFromToolData(data, item, result),
    outcomeFromToolData(payload, data, item, result),
  );
  const isError = isErrorFromToolData(payload, data, item, result);

  return { toolName, args, content, ...(isError === undefined ? {} : { isError }) };
}

function toolNameForItemType(itemType: ToolLifecycleItemType): string {
  return itemType;
}

function argsFromToolData(
  data: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const input = data.input;
  if (isRecord(input)) return input;

  const itemInput = item?.input;
  if (isRecord(itemInput)) return itemInput;

  const source = item ?? data;
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      [
        "aggregatedOutput",
        "output",
        "result",
        "status",
        "exitCode",
        "durationMs",
        "processId",
        "id",
      ].includes(key)
    ) {
      continue;
    }
    args[key] = value;
  }
  return args;
}

function outputFromToolData(
  data: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): string {
  const fullOutput = stringOrNull(result?.fullOutput);
  if (fullOutput !== null) return fullOutput;

  const codexOutput = stringOrNull(item?.aggregatedOutput);
  if (codexOutput !== null) return codexOutput;

  const preview = stringifyContent(result?.content ?? data.output ?? item?.output ?? "");
  const marker = metadataOnlyMarker(result);
  if (marker === null) return preview;
  if (preview === "") return marker;
  return `${preview}\n${marker}`;
}

function metadataOnlyMarker(result: Record<string, unknown> | undefined): string | null {
  if (result === undefined) return null;
  const path = stringOrNull(result.fullOutputPath);
  const size = typeof result.fullOutputSize === "number" ? result.fullOutputSize : null;
  if (path === null || size === null) return null;
  return `[full output ${String(size)} bytes at ${path} not captured]`;
}

function outcomeFromToolData(
  payload: ItemLifecyclePayload,
  data: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): string | null {
  const parts: string[] = [];
  const exitCode = numberOrNull(item?.exitCode ?? data.exitCode ?? result?.exitCode);
  if (exitCode !== null) parts.push(`exitCode=${String(exitCode)}`);
  const status = stringOrNull(item?.status ?? data.status ?? payload.status);
  if (status !== null) parts.push(`status=${status}`);
  return parts.length === 0 ? null : `[tool outcome: ${parts.join(" ")}]`;
}

function appendOutcome(content: string, outcome: string | null): string {
  if (outcome === null) return content;
  if (content === "") return outcome;
  return `${content}\n${outcome}`;
}

function isErrorFromToolData(
  payload: ItemLifecyclePayload,
  data: Record<string, unknown>,
  item: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined,
): boolean | undefined {
  if (typeof result?.is_error === "boolean") return result.is_error;
  if (typeof result?.isError === "boolean") return result.isError;
  const exitCode = numberOrNull(item?.exitCode ?? data.exitCode ?? result?.exitCode);
  if (exitCode !== null) return exitCode !== 0;
  const status = stringOrNull(item?.status ?? data.status ?? payload.status);
  if (status === null) return undefined;
  return ["failed", "error", "cancelled", "interrupted", "declined"].includes(status);
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function malformed(skips: Record<string, number>): CaptureMapResult {
  incrementCounter(skips, "malformed");
  return { events: [], skips };
}

function isItemPayload(value: unknown): value is ItemLifecyclePayload {
  if (!isRecord(value) || typeof value.itemType !== "string") return false;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export type { CaptureMapResult };
