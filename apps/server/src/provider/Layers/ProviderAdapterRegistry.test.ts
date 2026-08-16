import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it, vi } from "@effect/vitest";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import * as ProviderAdapterRegistryLayer from "./ProviderAdapterRegistry.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const DEFAULT_CLAUDE_ID = defaultInstanceIdForDriver(CLAUDE_DRIVER);
const WORK_CLAUDE_ID = ProviderInstanceId.make("claude_work");

const makeFakeAdapter = (): ProviderAdapterShape<never> => ({
  provider: CLAUDE_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
});

const makeFakeInstance = (
  instanceId: ProviderInstanceId,
  displayName: string | undefined,
): ProviderInstance => ({
  instanceId,
  driverKind: CLAUDE_DRIVER,
  continuationIdentity: {
    driverKind: CLAUDE_DRIVER,
    continuationKey: `claudeAgent:instance:${instanceId}`,
  },
  displayName,
  enabled: true,
  snapshot: {
    maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
      provider: CLAUDE_DRIVER,
      packageName: null,
    }),
    getSnapshot: Effect.succeed({} as ServerProvider),
    refresh: Effect.succeed({} as ServerProvider),
    streamChanges: Stream.empty,
  },
  adapter: makeFakeAdapter(),
  textGeneration: {} as TextGeneration.TextGeneration["Service"],
});

const instances = [
  makeFakeInstance(DEFAULT_CLAUDE_ID, undefined),
  makeFakeInstance(WORK_CLAUDE_ID, "Claude Work"),
];

const registryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(instances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(instances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
});

const layer = Layer.mergeAll(
  ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive.pipe(Layer.provide(registryLayer)),
  NodeServices.layer,
);

it.layer(layer)("ProviderAdapterRegistryLive", (it) => {
  it("routes default and named Claude instances", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;

      assert.strictEqual(yield* registry.getByInstance(DEFAULT_CLAUDE_ID), instances[0]!.adapter);
      assert.strictEqual(yield* registry.getByInstance(WORK_CLAUDE_ID), instances[1]!.adapter);

      assert.deepStrictEqual(yield* registry.listInstances(), [DEFAULT_CLAUDE_ID, WORK_CLAUDE_ID]);
      assert.deepStrictEqual(yield* registry.listProviders(), [CLAUDE_DRIVER]);

      assert.deepStrictEqual(yield* registry.getInstanceInfo(WORK_CLAUDE_ID), {
        instanceId: WORK_CLAUDE_ID,
        driverKind: CLAUDE_DRIVER,
        displayName: "Claude Work",
        accentColor: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: CLAUDE_DRIVER,
          continuationKey: "claudeAgent:instance:claude_work",
        },
      });
    }));
});
