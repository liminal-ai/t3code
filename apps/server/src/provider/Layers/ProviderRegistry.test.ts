import { assert, it } from "@effect/vitest";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  haveProvidersChanged,
  mergeProviderSnapshot,
  mergeProviderSnapshots,
  selectProvidersByKind,
} from "./ProviderRegistry.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const emptyCapabilities = createModelCapabilities({ optionDescriptors: [] });

const makeProvider = (overrides?: Partial<ServerProvider>): ServerProvider => ({
  instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
  driver: CLAUDE_DRIVER,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-08-16T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it("retains known Claude models during a partial refresh", () => {
  const previous = makeProvider({
    models: [
      {
        slug: "claude-sonnet-4-5",
        name: "Sonnet",
        isCustom: false,
        capabilities: emptyCapabilities,
      },
    ],
  });
  const next = makeProvider({ status: "warning", models: [] });

  assert.deepStrictEqual(mergeProviderSnapshot(previous, next).models, previous.models);
});

it("keeps model capabilities when a refresh omits them", () => {
  const capabilities = createModelCapabilities({
    optionDescriptors: [{ id: "effort", type: "select", label: "Effort", options: [] }],
  });
  const previous = makeProvider({
    models: [{ slug: "claude-opus-4-1", name: "Opus", isCustom: false, capabilities }],
  });
  const next = makeProvider({
    models: [
      {
        slug: "claude-opus-4-1",
        name: "Opus",
        isCustom: false,
        capabilities: emptyCapabilities,
      },
    ],
  });

  assert.deepStrictEqual(
    mergeProviderSnapshot(previous, next).models[0]?.capabilities,
    capabilities,
  );
});

it("orders and updates multiple Claude instances by instance identity", () => {
  const workId = ProviderInstanceId.make("claude_work");
  const personal = makeProvider();
  const work = makeProvider({ instanceId: workId, displayName: "Claude Work" });
  const refreshedWork = makeProvider({
    instanceId: workId,
    displayName: "Claude Work",
    version: "2.0.0",
  });

  const merged = mergeProviderSnapshots([personal, work], [refreshedWork]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((provider) => provider.instanceId === workId)?.version, "2.0.0");
  assert.deepStrictEqual(selectProvidersByKind(merged, new Set([CLAUDE_DRIVER])), merged);
  assert.equal(haveProvidersChanged([personal, work], merged), true);
});
