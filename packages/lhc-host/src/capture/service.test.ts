// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { initLhc, type Lhc, type MessageEventInput, type OpResult } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { mapProviderRuntimeEvent } from "../intake/index.ts";
import {
  DRAIN_NOT_SETTLED_MESSAGE,
  startCaptureService,
  type CaptureService,
  type CaptureServiceOptions,
} from "./service.ts";

let home: string;
let services: CaptureService[];

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-capture-"));
  services = [];
});

afterEach(async () => {
  for (const service of services) await service.stop();
  NodeFS.rmSync(home, { recursive: true, force: true });
});

function makeService(options: CaptureServiceOptions = {}): CaptureService {
  const service = startCaptureService({
    home,
    noInference: true,
    logError: () => {},
    ...options,
  });
  services.push(service);
  return service;
}

function assertOk<T>(result: OpResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt-${String(eventCounter)}`;
}

interface FakeEventInput {
  threadId: string;
  turnId?: string;
  itemId?: string;
  provider?: string;
}

function turnStarted(input: FakeEventInput): Record<string, unknown> {
  return {
    type: "turn.started",
    eventId: nextEventId(),
    threadId: input.threadId,
    turnId: input.turnId,
    provider: input.provider ?? "codex",
    payload: {},
  };
}

function userMessage(input: FakeEventInput & { text: string }): Record<string, unknown> {
  return {
    type: "item.completed",
    eventId: nextEventId(),
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: input.itemId ?? nextEventId(),
    provider: input.provider ?? "codex",
    payload: { itemType: "user_message", detail: input.text },
  };
}

function assistantMessage(input: FakeEventInput & { text: string }): Record<string, unknown> {
  return {
    type: "item.completed",
    eventId: nextEventId(),
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: input.itemId ?? nextEventId(),
    provider: input.provider ?? "codex",
    payload: { itemType: "assistant_message", detail: input.text },
  };
}

function turnCompleted(input: FakeEventInput): Record<string, unknown> {
  return {
    type: "turn.completed",
    eventId: nextEventId(),
    threadId: input.threadId,
    turnId: input.turnId,
    provider: input.provider ?? "codex",
    payload: { state: "completed" },
  };
}

async function listEvents(service: CaptureService, t3ThreadId: string) {
  const ref = service.threadRef(t3ThreadId);
  expect(ref).toBeDefined();
  const sdk = service.sdk;
  expect(sdk).toBeDefined();
  return assertOk(await sdk!.intakeStream.listEvents(ref!));
}

describe("capture service", () => {
  it("records a scripted provider stream into a durable LHC thread", async () => {
    const service = makeService();
    const threadId = "t3-record";
    service.handleEvent(turnStarted({ threadId, turnId: "turn-1" }));
    service.handleEvent(userMessage({ threadId, turnId: "turn-1", text: "hello capture" }));
    service.handleEvent(assistantMessage({ threadId, turnId: "turn-1", text: "hi back" }));
    service.handleEvent(turnCompleted({ threadId, turnId: "turn-1" }));
    await service.settle();

    const events = await listEvents(service, threadId);
    expect(events.map((event) => event.eventKind)).toEqual([
      "user_prompt",
      "assistant_text",
      "turn_end",
    ]);
    expect((events[0]!.payload as { text: string }).text).toBe("hello capture");

    const ref = service.threadRef(threadId)!;
    const messages = assertOk(await service.sdk!.messages.list(ref));
    expect(messages.map((message) => message.kind)).toEqual(["user_prompt", "assistant_text"]);
    const overview = await service.sdk!.inspect.overview(ref);
    expect(overview.ok).toBe(true);

    const stats = service.stats();
    expect(stats.eventsSeen).toBe(4);
    expect(stats.global.intake.recorded).toBe(3);
    expect(stats.global.intake.failedBatches).toBe(0);
    expect(stats.threads).toHaveLength(1);
    expect(stats.threads[0]!.lhcThreadId).toBe(ref.threadId);
  });

  it("keeps per-thread order under genuinely concurrent multi-thread emission", async () => {
    const service = makeService();
    const threads = ["t3-a", "t3-b", "t3-c", "t3-d"];
    const perThread = 12;
    for (const threadId of threads) {
      service.handleEvent(turnStarted({ threadId, turnId: `${threadId}-turn` }));
    }
    // Drive each thread's emission from its own async task and race them with
    // Promise.all; the awaits hand control back to the event loop between
    // events so different threads' events genuinely intermix rather than
    // following a fixed round-robin. Per-thread FIFO must survive that.
    await Promise.all(
      threads.map((threadId) =>
        (async () => {
          for (let index = 0; index < perThread; index += 1) {
            service.handleEvent(
              assistantMessage({
                threadId,
                turnId: `${threadId}-turn`,
                text: `${threadId} message ${String(index)}`,
              }),
            );
            await Promise.resolve();
          }
        })(),
      ),
    );
    await service.settle();

    const refs = new Set<string>();
    for (const threadId of threads) {
      const events = await listEvents(service, threadId);
      const texts = events
        .filter((event) => event.eventKind === "assistant_text")
        .map((event) => (event.payload as { text: string }).text);
      expect(texts).toEqual(
        Array.from({ length: perThread }, (_, index) => `${threadId} message ${String(index)}`),
      );
      refs.add(service.threadRef(threadId)!.threadId);
    }
    // One t3 thread ↔ one LHC thread: no cross-thread writes to one file.
    expect(refs.size).toBe(threads.length);
    expect(service.stats().global.pendingHigh).toBeGreaterThanOrEqual(1);
  });

  it("dedupes a host-injected prompt against a stream user_message with the same turnId", async () => {
    const service = makeService();

    // Injection first (Claude-like: no stream user_message would normally come,
    // but Codex emits one — same key either way).
    const first = "t3-inject-first";
    service.noteTurnStarted({
      threadId: first,
      turnId: "turn-9",
      prompt: "typed by user",
      provider: "codex",
    });
    service.handleEvent(turnStarted({ threadId: first, turnId: "turn-9" }));
    service.handleEvent(userMessage({ threadId: first, turnId: "turn-9", text: "typed by user" }));
    service.handleEvent(turnCompleted({ threadId: first, turnId: "turn-9" }));

    // Stream user_message first, injection afterwards: key-wins dedupe still
    // collapses to one prompt.
    const second = "t3-inject-second";
    service.handleEvent(turnStarted({ threadId: second, turnId: "turn-10" }));
    service.handleEvent(userMessage({ threadId: second, turnId: "turn-10", text: "typed again" }));
    service.noteTurnStarted({
      threadId: second,
      turnId: "turn-10",
      prompt: "typed again",
      provider: "codex",
    });
    service.handleEvent(turnCompleted({ threadId: second, turnId: "turn-10" }));

    await service.settle();

    for (const threadId of [first, second]) {
      const events = await listEvents(service, threadId);
      const prompts = events.filter((event) => event.eventKind === "user_prompt");
      expect(prompts).toHaveLength(1);
    }
    const stats = service.stats();
    expect(stats.global.intake.promptsInjected).toBe(2);
    expect(stats.global.intake.deduped).toBe(2);
  });

  it("ignores non-captured providers and empty prompts", async () => {
    const service = makeService();
    service.handleEvent(userMessage({ threadId: "t3-x", text: "nope", provider: "cursor" }));
    service.handleEvent({ not: "an event" });
    service.noteTurnStarted({ threadId: "t3-x", turnId: "t", prompt: "hi", provider: "cursor" });
    service.noteTurnStarted({ threadId: "t3-y", turnId: "t", prompt: "   ", provider: "codex" });
    await service.settle();

    const stats = service.stats();
    expect(stats.eventsSeen).toBe(0);
    expect(stats.eventsIgnored).toBe(2);
    expect(stats.threads.map((thread) => thread.t3ThreadId)).toEqual(["t3-y"]);
    expect(stats.global.intake.emptyPromptsSkipped).toBe(1);
    expect(stats.global.intake.batches).toBe(0);
  });

  it("counts an intake rejection without throwing, and keeps capturing after it", async () => {
    const errors: string[] = [];
    const service = makeService({
      logError: (message) => errors.push(message),
      mapFn: (event, options) => {
        const record = event as Record<string, unknown>;
        if (record.type === "poison") {
          // Deliberately contract-violating batch: unknown extra field is
          // rejected by the SDK's strict envelope validation.
          const poisoned = {
            eventKind: "user_prompt",
            idempotencyKey: "poison-key",
            actor: "user",
            harness: "t3code",
            payload: { text: "poison" },
            bogus: true,
          } as unknown as MessageEventInput;
          return { events: [poisoned], skips: {} };
        }
        return mapProviderRuntimeEvent(event, options);
      },
    });

    const threadId = "t3-poison";
    service.handleEvent({
      type: "poison",
      eventId: nextEventId(),
      threadId,
      provider: "codex",
      payload: {},
    });
    service.handleEvent(turnStarted({ threadId, turnId: "turn-1" }));
    service.handleEvent(userMessage({ threadId, turnId: "turn-1", text: "still alive" }));
    await service.settle();

    const stats = service.stats();
    expect(stats.global.intake.failedBatches).toBe(1);
    expect(stats.global.intake.intakeThrew).toBe(0);
    expect(errors.some((message) => message.includes("intake rejected"))).toBe(true);

    // The fail-soft log was actually written to the thread, not just counted.
    const ref = service.threadRef(threadId)!;
    const logs = assertOk(await service.sdk!.logging.query(ref, { level: "error" }));
    expect(logs.some((entry) => entry.message.includes("intake rejected"))).toBe(true);

    const events = await listEvents(service, threadId);
    expect(events.map((event) => event.eventKind)).toEqual(["user_prompt"]);
    expect((events[0]!.payload as { text: string }).text).toBe("still alive");
  });

  it("counts lineage failures without throwing", async () => {
    const errors: string[] = [];
    const service = makeService({
      logError: (message) => errors.push(message),
      lineageDeps: {
        newThreadFn: async () => ({
          ok: false,
          error: { errorClass: "system_error", code: "storage_failure", reason: "boom" },
        }),
      },
    });
    service.handleEvent(userMessage({ threadId: "t3-lineage", turnId: "t1", text: "lost" }));
    await service.settle();

    const stats = service.stats();
    expect(stats.global.intake.lineageFailures).toBe(1);
    expect(stats.global.intake.batches).toBe(0);
    expect(errors.some((message) => message.includes("lineage failed"))).toBe(true);
  });

  it("stop flushes queued events and is idempotent; events after stop are dropped", async () => {
    const service = makeService();
    const threadId = "t3-stop";
    service.handleEvent(turnStarted({ threadId, turnId: "turn-1" }));
    service.handleEvent(userMessage({ threadId, turnId: "turn-1", text: "flushed on stop" }));

    // No settle: stop() itself must flush the queued work.
    await service.stop();

    const events = await listEvents(service, threadId);
    expect(events.map((event) => event.eventKind)).toEqual(["user_prompt"]);

    const seenBefore = service.stats().eventsSeen;
    service.handleEvent(assistantMessage({ threadId, turnId: "turn-1", text: "too late" }));
    await service.stop();
    expect(service.stats().eventsSeen).toBe(seenBefore);
  });

  it("awaits drainSettled per touched thread in background mode, capped in total", async () => {
    const drained: string[] = [];
    let resolveHang: (() => void) | undefined;
    const makeStub = (drainSettled: (ref: unknown) => Promise<void>): Lhc =>
      ({
        intakeStream: {
          messageEvents: async () => ({
            ok: true,
            value: {
              events: [{ idempotencyKey: "k", outcome: "recorded" }],
              turnTransitions: [],
              queuedWork: [],
              threadPosition: { lastEventOrder: 1 },
            },
          }),
        },
        logging: { write: async () => ({ ok: true, value: undefined }) },
        drainSettled,
      }) as unknown as Lhc;

    const settledService = makeService({
      noInference: false,
      initSdkFn: () =>
        makeStub(async (ref) => {
          drained.push((ref as { threadId: string }).threadId);
        }),
    });
    expect(settledService.mode).toBe("background");
    settledService.handleEvent(userMessage({ threadId: "t3-drain", turnId: "t1", text: "hi" }));
    await settledService.stop();
    expect(drained).toHaveLength(1);

    const errors: string[] = [];
    const hangingService = makeService({
      noInference: false,
      drainSettledCapMs: 50,
      logError: (message) => errors.push(message),
      initSdkFn: () =>
        makeStub(
          () =>
            new Promise<void>((resolve) => {
              resolveHang = resolve;
            }),
        ),
    });
    hangingService.handleEvent(userMessage({ threadId: "t3-hang", turnId: "t1", text: "hi" }));
    await hangingService.stop();
    expect(errors).toContain(DRAIN_NOT_SETTLED_MESSAGE);
    resolveHang?.();
  });

  it("stops under the cap when an intake job is wedged (settle phase, not just drain)", async () => {
    const errors: string[] = [];
    const service = makeService({
      noInference: true,
      drainSettledCapMs: 50,
      logError: (message) => errors.push(message),
      initSdkFn: (config) => {
        const real = initLhc(config);
        return {
          ...real,
          intakeStream: {
            ...real.intakeStream,
            // Wedge: this intake never resolves, so settleQueues would hang
            // forever without the total-deadline cap.
            messageEvents: () => new Promise(() => {}),
          },
        } as unknown as Lhc;
      },
    });
    service.handleEvent(userMessage({ threadId: "t3-wedge", turnId: "t1", text: "hang" }));

    // If the cap were bypassed this would exceed vitest's test timeout; instead
    // stop() resolves via the 50ms deadline, then runs teardown in `finally`.
    await service.stop();
    expect(errors).toContain(DRAIN_NOT_SETTLED_MESSAGE);
    expect(service.stats().threads[0]!.pending).toBe(1); // job still wedged, teardown still ran
    // Idempotent: second stop resolves off the memoized promise.
    await service.stop();
  });

  it("manual mode skips drainSettled at stop", async () => {
    let drainCalls = 0;
    const service = makeService({
      initSdkFn: (config) => {
        const sdk = initLhc(config);
        return {
          ...sdk,
          drainSettled: async (ref: Parameters<Lhc["drainSettled"]>[0]) => {
            drainCalls += 1;
            return sdk.drainSettled(ref);
          },
        };
      },
    });
    expect(service.mode).toBe("manual");
    service.handleEvent(userMessage({ threadId: "t3-manual", turnId: "t1", text: "hi" }));
    await service.stop();
    expect(drainCalls).toBe(0);
  });

  it("is a complete no-op when disabled", async () => {
    const service = makeService({ disabled: true });
    expect(service.enabled).toBe(false);
    expect(service.mode).toBe("disabled");
    expect(service.sdk).toBeUndefined();
    service.handleEvent(userMessage({ threadId: "t3-off", turnId: "t1", text: "hi" }));
    service.noteTurnStarted({ threadId: "t3-off", turnId: "t1", prompt: "hi", provider: "codex" });
    await service.settle();
    expect(service.stats().eventsSeen).toBe(0);
    expect(service.threadRef("t3-off")).toBeUndefined();
    await service.stop();
    await service.stop();
  });
});
