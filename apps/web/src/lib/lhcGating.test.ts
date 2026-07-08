import { describe, expect, it } from "vite-plus/test";

import { resolveLhcActionGate, isLhcActionProviderKind } from "./lhcGating";

describe("lhcGating", () => {
  describe("isLhcActionProviderKind", () => {
    it("accepts claudeAgent and codex", () => {
      expect(isLhcActionProviderKind("claudeAgent")).toBe(true);
      expect(isLhcActionProviderKind("codex")).toBe(true);
    });

    it("rejects other providers", () => {
      expect(isLhcActionProviderKind("cursor")).toBe(false);
      expect(isLhcActionProviderKind(null)).toBe(false);
    });
  });

  describe("resolveLhcActionGate", () => {
    it("hides actions when the thread is not captured", () => {
      expect(
        resolveLhcActionGate({
          providerKind: "claudeAgent",
          captured: false,
          turnInFlight: false,
        }),
      ).toEqual({
        showActions: false,
        actionsDisabled: true,
        actionsDisabledReason: null,
      });
    });

    it("hides actions for unsupported providers", () => {
      expect(
        resolveLhcActionGate({
          providerKind: "cursor",
          captured: true,
          turnInFlight: false,
        }),
      ).toEqual({
        showActions: false,
        actionsDisabled: true,
        actionsDisabledReason: null,
      });
    });

    it("shows enabled actions for supported captured idle threads", () => {
      expect(
        resolveLhcActionGate({
          providerKind: "codex",
          captured: true,
          turnInFlight: false,
        }),
      ).toEqual({
        showActions: true,
        actionsDisabled: false,
        actionsDisabledReason: null,
      });
    });

    it("disables actions while a turn is in flight", () => {
      expect(
        resolveLhcActionGate({
          providerKind: "claudeAgent",
          captured: true,
          turnInFlight: true,
        }),
      ).toEqual({
        showActions: true,
        actionsDisabled: true,
        actionsDisabledReason: "Finish the current turn first",
      });
    });
  });
});
