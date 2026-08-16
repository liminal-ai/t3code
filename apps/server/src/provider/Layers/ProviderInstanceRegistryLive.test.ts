import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type ClaudeSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ClaudeDriver } from "../Drivers/ClaudeDriver.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistryLive.ts";

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  ...overrides,
});

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "provider-instance-registry-test",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(TestHttpClientLive),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

describe("ProviderInstanceRegistryLive — Claude-only build", () => {
  it.live("boots independent Claude instances", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("claude_personal");
      const workId = ProviderInstanceId.make("claude_work");
      const driver = ProviderDriverKind.make("claudeAgent");
      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver,
          displayName: "Claude Personal",
          enabled: false,
          config: makeClaudeConfig({ homePath: "/tmp/claude-personal" }),
        },
        [workId]: {
          driver,
          displayName: "Claude Work",
          enabled: false,
          config: makeClaudeConfig({ homePath: "/tmp/claude-work" }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [ClaudeDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === driver)).toBe(true);
      expect(instances[0]!.adapter).not.toBe(instances[1]!.adapter);
      expect(yield* registry.listUnavailable).toEqual([]);
    }).pipe(Effect.provide(testLayer)),
  );

  it.live("keeps an unknown legacy driver as unavailable without starting it", () =>
    Effect.gen(function* () {
      const legacyId = ProviderInstanceId.make("legacy_provider");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [ClaudeDriver],
        configMap: {
          [legacyId]: {
            driver: ProviderDriverKind.make("legacy"),
            displayName: "Legacy provider",
          },
        },
      });

      expect(yield* registry.listInstances).toEqual([]);
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toHaveLength(1);
      expect(unavailable[0]?.instanceId).toBe(legacyId);
      expect(unavailable[0]?.status).toBe("disabled");
    }).pipe(Effect.provide(testLayer)),
  );
});
