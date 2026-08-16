import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";

import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";

it("preserves historical provider identities while adding the default Claude instance", () => {
  const claudeWorkId = ProviderInstanceId.make("claude_work");
  const codexPersonalId = ProviderInstanceId.make("codex_personal");
  const config = deriveProviderInstanceConfigMap({
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: {
      [claudeWorkId]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        displayName: "Claude Work",
      },
      [codexPersonalId]: {
        driver: ProviderDriverKind.make("codex"),
        displayName: "Codex Personal",
      },
    },
  });

  assert.deepStrictEqual(Object.keys(config).sort(), [
    "claudeAgent",
    "claude_work",
    "codex_personal",
  ]);
  assert.equal(config[claudeWorkId]?.driver, "claudeAgent");
  assert.equal(config[codexPersonalId]?.driver, "codex");
});
