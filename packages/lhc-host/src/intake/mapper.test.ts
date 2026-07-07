// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type MessageEventInput,
  type OpResult,
} from "lhc";
import { describe, expect, it } from "vite-plus/test";

import {
  createCaptureStats,
  createTurnAccumulator,
  mapProviderRuntimeEvent,
  recordCaptureMapResult,
  userPromptEvent,
} from "./index.ts";

type RuntimeFixtureEvent = {
  type: string;
  eventId: string;
  threadId: string;
  turnId?: string;
  itemId?: string;
  payload: unknown;
};

interface ReplayOptions {
  injectPrompts?: boolean;
}

const CODEX_FIXTURE = fixturePath("event-fidelity/codex/codex-normalized.jsonl");
const CLAUDE_FIXTURE = fixturePath("event-fidelity/claude/post-patch/claude-normalized.jsonl");
const SYNTHETIC_FIXTURE = fixturePath("intake/synthetic.jsonl");
const METADATA_TOOL_FIXTURE = fixturePath("intake/claude-metadata-tool.jsonl");

function fixturePath(relativePath: string): string {
  return NodePath.join(import.meta.dirname, "../../test/fixtures", relativePath);
}

function readJsonl(path: string): RuntimeFixtureEvent[] {
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RuntimeFixtureEvent);
}

function injectedPromptText(turnId: string, index: number): string {
  return `host injected prompt ${String(index + 1)} for ${turnId}`;
}

function replayFixture(
  path: string,
  options: ReplayOptions = {},
): {
  events: MessageEventInput[];
  stats: ReturnType<typeof createCaptureStats>;
  streamUserPrompts: number;
} {
  const accumulator = createTurnAccumulator();
  const stats = createCaptureStats();
  const events: MessageEventInput[] = [];
  let injectedTurns = 0;
  let streamUserPrompts = 0;

  for (const event of readJsonl(path)) {
    if (
      options.injectPrompts === true &&
      event.type === "turn.started" &&
      event.turnId !== undefined
    ) {
      events.push(
        userPromptEvent(
          event.threadId,
          event.turnId,
          injectedPromptText(event.turnId, injectedTurns),
        ),
      );
      injectedTurns += 1;
    }

    const result = mapProviderRuntimeEvent(event, { turnAccumulator: accumulator });
    recordCaptureMapResult(stats, result);
    streamUserPrompts += result.events.filter(
      (mapped) => mapped.eventKind === "user_prompt",
    ).length;
    events.push(...result.events);
  }

  return { events, stats, streamUserPrompts };
}

function sequenceSnapshot(events: readonly MessageEventInput[]): Array<Record<string, unknown>> {
  return events.map((event) => {
    const payload = event.payload as Record<string, unknown>;
    return {
      kind: event.eventKind,
      key: event.idempotencyKey,
      ...(typeof payload.toolCallId === "string" ? { toolCallId: payload.toolCallId } : {}),
    };
  });
}

function assertOk<T>(result: OpResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.reason);
  }
  return result.value;
}

function tempStore(): {
  dir: string;
  registryPath: string;
  threadPath: string;
  cleanup: () => void;
} {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-intake-"));
  return {
    dir,
    registryPath: NodePath.join(dir, "registry.sqlite"),
    threadPath: NodePath.join(dir, "thread.sqlite"),
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

async function replayIntoRealLhc(
  path: string,
  expectedClosedTurns: number,
  expectedPassOneSkipped = 0,
): Promise<void> {
  const store = tempStore();
  try {
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });
    const created = assertOk(
      await sdk.threads.newThread({
        filePath: store.threadPath,
        registryPath: store.registryPath,
      }),
    );

    const { events } = replayFixture(path, { injectPrompts: true });
    const first = assertOk(
      await sdk.intakeStream.messageEvents({ filePath: created.filePath }, events),
    );
    const recordedFirst = first.events.filter((entry) => entry.outcome === "recorded").length;
    const skippedFirst = first.events.filter((entry) => entry.outcome === "skipped").length;
    expect(recordedFirst).toBeGreaterThan(0);
    expect(skippedFirst).toBe(expectedPassOneSkipped);

    const second = assertOk(
      await sdk.intakeStream.messageEvents({ filePath: created.filePath }, events),
    );
    expect(second.events).toHaveLength(events.length);
    expect(second.events.every((entry) => entry.outcome === "skipped")).toBe(true);
    expect(second.events.every((entry) => entry.skipReason === "duplicate_idempotency_key")).toBe(
      true,
    );

    const listedEvents = assertOk(
      await sdk.intakeStream.listEvents({ filePath: created.filePath }),
    );
    expect(listedEvents).toHaveLength(recordedFirst);

    const overview = assertOk(await sdk.inspect.overview({ filePath: created.filePath }));
    expect(overview.turns).toEqual({ open: 1, closed: expectedClosedTurns });
    expect(overview.messages.visible).toBeGreaterThan(expectedClosedTurns);
  } finally {
    store.cleanup();
  }
}

describe("provider runtime to LHC intake mapper", () => {
  it("replays the Codex fidelity fixture with stream-derived user prompts", () => {
    const replay = replayFixture(CODEX_FIXTURE);

    expect(replay.streamUserPrompts).toBe(3);
    expect(replay.stats.skips["content.delta"]).toBeUndefined();
    expect(sequenceSnapshot(replay.events)).toMatchSnapshot();
  });

  it("replays the Claude post-patch fixture and uses host-injected user prompts", () => {
    const streamOnly = replayFixture(CLAUDE_FIXTURE);
    expect(streamOnly.streamUserPrompts).toBe(0);

    const withInjection = replayFixture(CLAUDE_FIXTURE, { injectPrompts: true });
    expect(withInjection.events.filter((event) => event.eventKind === "user_prompt")).toHaveLength(
      2,
    );
    expect(sequenceSnapshot(withInjection.events)).toMatchSnapshot();
  });

  it("maps synthetic edge cases without throwing and counts skips", () => {
    const replay = replayFixture(SYNTHETIC_FIXTURE);
    const toolResult = replay.events.find((event) => event.eventKind === "tool_result");
    const compactionNote = replay.events.find(
      (event) =>
        event.eventKind === "runtime_note" &&
        (event.payload as { text?: string }).text === "provider-native compaction",
    );
    const interruptedTail = replay.events.slice(-2).map((event) => event.eventKind);

    expect(replay.events[0]?.eventKind).toBe("tool_call");
    expect(replay.events[1]?.eventKind).toBe("tool_result");
    expect((toolResult?.payload as { content?: string } | undefined)?.content).toContain(
      "agent summary complete",
    );
    expect(replay.stats.skips["item.future_item"]).toBe(1);
    expect(replay.stats.skips["future.event"]).toBe(1);
    expect(replay.stats.skips.user_message_no_turn).toBe(1);
    expect(replay.stats.skips.context_compaction).toBe(1);
    expect(replay.stats.malformed).toBe(1);
    expect(compactionNote).toBeDefined();
    expect(interruptedTail).toEqual(["runtime_note", "turn_end"]);
  });

  it("marks Claude metadata-only tool output when full output is absent", () => {
    const replay = replayFixture(METADATA_TOOL_FIXTURE);
    const toolResult = replay.events.find((event) => event.eventKind === "tool_result");

    expect((toolResult?.payload as { content?: string } | undefined)?.content).toContain(
      "[full output 48894 bytes at /tmp/lhc/full-output.txt not captured]",
    );
  });

  it("feeds real LHC intake twice without duplicate records or turn corruption", async () => {
    await replayIntoRealLhc(CODEX_FIXTURE, 3, 3);
    await replayIntoRealLhc(CLAUDE_FIXTURE, 2);
  });
});
