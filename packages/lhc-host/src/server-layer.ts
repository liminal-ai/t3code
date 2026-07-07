/**
 * Effect Layer the t3code server composes to run LHC capture (Slice 1.2).
 *
 * The layer is deliberately tag-free toward the server: apps/server passes a
 * wiring effect that resolves the two touch points (the unified provider
 * runtime event stream and the sendTurn observation hook), so no server
 * service tags leak into this package and no lhc-host types leak into
 * provider modules beyond the named hook.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Pull from "effect/Pull";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  startCaptureService,
  type CaptureService,
  type CaptureServiceOptions,
  type TurnStartedInfo,
} from "./capture/service.ts";

export type { CaptureService, CaptureServiceOptions, TurnStartedInfo };

export interface LhcCaptureWiring {
  /** The server's unified ProviderRuntimeEvent stream (ProviderService.streamEvents). */
  readonly streamEvents: Stream.Stream<unknown>;
  /**
   * Registers the capture observer at the server's sendTurn choke point and
   * returns a disposer that unregisters it (called during service stop()).
   */
  readonly registerTurnStarted: (observer: (info: TurnStartedInfo) => void) => () => void;
}

export class LhcCaptureService extends Context.Service<LhcCaptureService, CaptureService>()(
  "@t3tools/lhc-host/server-layer/LhcCaptureService",
) {}

/**
 * Start capture when the layer builds (after the provider layer, since the
 * wiring effect requires it) and stop it when the layer's scope closes —
 * queued events flush, drain-settle is awaited (capped), inference children
 * are killed. With `T3CODE_LHC_DISABLE=1` the service is a no-op and no
 * stream subscription is made.
 */
export const makeLhcCaptureLayer = <E, R>(
  wiring: Effect.Effect<LhcCaptureWiring, E, R>,
  options: CaptureServiceOptions = {},
): Layer.Layer<LhcCaptureService, E, Exclude<R, Scope.Scope>> =>
  Layer.effect(
    LhcCaptureService,
    Effect.gen(function* () {
      const resolved = yield* wiring;
      const service = startCaptureService(options);
      if (service.enabled) {
        const dispose = resolved.registerTurnStarted((info) => service.noteTurnStarted(info));
        service.onStop(dispose);
        // Subscription-attached guarantee: `Stream.toPull` acquires the
        // underlying PubSub subscription HERE, in the construction fiber's
        // scope, before the service is yielded. A live PubSub has no replay, so
        // attaching synchronously is what makes "capture is running" true for
        // every event published after this point — no gap between construct and
        // fork. The forked loop then drains it; scope close releases both the
        // subscription and the fiber.
        const pull = yield* Stream.toPull(resolved.streamEvents);
        const pump = Effect.flatMap(pull, (events) =>
          Effect.sync(() => {
            for (const event of events) service.handleEvent(event);
          }),
        );
        yield* Effect.forkScoped(
          Effect.forever(pump).pipe(
            Pull.catchDone(() => Effect.void),
            Effect.catchCause((cause) =>
              Effect.logWarning("t3code-lhc capture stream stopped", { cause }),
            ),
          ),
        );
      }
      yield* Effect.addFinalizer(() => Effect.promise(() => service.stop().catch(() => {})));
      return service;
    }),
  );
