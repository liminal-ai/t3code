// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { OpResult } from "lhc";

import { LhcCaptureService, makeLhcCaptureLayer, type TurnStartedInfo } from "./server-layer.ts";

let home: string;

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-layer-"));
});

afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
});

function assertOk<T>(result: OpResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

function waitFor(predicate: () => boolean, timeoutMs = 5_000): Effect.Effect<void> {
  return Effect.gen(function* () {
    const deadline = (yield* Effect.clockWith((clock) => clock.currentTimeMillis)) + timeoutMs;
    while (!predicate()) {
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      if (now > deadline) return yield* Effect.die(new Error("waitFor timed out"));
      yield* Effect.sleep("10 millis");
    }
  });
}

const fakeEvents = [
  {
    type: "turn.started",
    eventId: "evt-1",
    threadId: "t3-layer",
    turnId: "turn-1",
    provider: "codex",
    payload: {},
  },
  {
    type: "item.completed",
    eventId: "evt-2",
    threadId: "t3-layer",
    turnId: "turn-1",
    itemId: "item-1",
    provider: "codex",
    payload: { itemType: "assistant_message", detail: "from the layer" },
  },
  {
    type: "turn.completed",
    eventId: "evt-3",
    threadId: "t3-layer",
    turnId: "turn-1",
    provider: "codex",
    payload: { state: "completed" },
  },
];

describe("server layer", () => {
  // it.live: the capture service runs on real promise timing, so the polling
  // wait below needs the live clock, not the test clock.
  it.live("subscribes the stream, registers the turn observer, and stops on scope close", () =>
    Effect.gen(function* () {
      let observer: ((info: TurnStartedInfo) => void) | undefined;
      let disposed = false;
      const layer = makeLhcCaptureLayer(
        Effect.succeed({
          streamEvents: Stream.fromArray(fakeEvents),
          registerTurnStarted: (callback: (info: TurnStartedInfo) => void) => {
            observer = callback;
            return () => {
              disposed = true;
            };
          },
        }),
        { home, noInference: true, logError: () => {} },
      );

      // Build with an explicit scope so the finalizer (service.stop) can be
      // observed after close.
      const scope = yield* Scope.make();
      const context = yield* Layer.build(layer).pipe(Effect.provideService(Scope.Scope, scope));
      const service = Context.get(context, LhcCaptureService);

      expect(service.enabled).toBe(true);
      expect(observer).toBeDefined();

      // The forked subscription drains the fake stream.
      yield* waitFor(() => service.stats().eventsSeen >= 3);

      // The sendTurn tap routes through the registered observer.
      observer!({
        threadId: "t3-layer",
        turnId: "turn-1",
        prompt: "typed at the choke point",
        provider: "codex",
      });
      yield* Effect.promise(() => service.settle());

      const ref = service.threadRef("t3-layer");
      expect(ref).toBeDefined();
      const events = assertOk(
        yield* Effect.promise(() => service.sdk!.intakeStream.listEvents(ref!)),
      );
      expect(events.map((event) => event.eventKind)).toEqual([
        "assistant_text",
        "turn_end",
        "user_prompt",
      ]);

      // Scope close runs the finalizer: the service stops, the observer is
      // disposed, and new events drop.
      yield* Scope.close(scope, Exit.void);
      expect(disposed).toBe(true);
      const seen = service.stats().eventsSeen;
      service.handleEvent(fakeEvents[1]);
      expect(service.stats().eventsSeen).toBe(seen);
    }),
  );
});
