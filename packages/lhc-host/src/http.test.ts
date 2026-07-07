import { describe, expect, it } from "vite-plus/test";

import { handleLhcHttpRequest } from "./http.ts";
import { ClaudeSwapError, type ClaudeSwapController } from "./swap/claude.ts";

function controller(overrides: Partial<ClaudeSwapController> = {}): ClaudeSwapController {
  return {
    status: async () => ({ capture: { enabled: true }, threads: [] }) as never,
    inspectThread: async (t3ThreadId) => ({ t3ThreadId, lhcThreadId: "lhc-1" }) as never,
    compactThread: async (t3ThreadId) => ({ op: "compact", t3ThreadId }) as never,
    pruneThread: async (t3ThreadId) => ({ op: "prune", t3ThreadId }) as never,
    ...overrides,
  };
}

describe("LHC HTTP handler", () => {
  it("serves status and inspect happy paths", async () => {
    await expect(
      handleLhcHttpRequest(controller(), { method: "GET", pathname: "/lhc/status" }),
    ).resolves.toMatchObject({ status: 200, body: { ok: true } });

    await expect(
      handleLhcHttpRequest(controller(), { method: "GET", pathname: "/lhc/threads/t3-1" }),
    ).resolves.toMatchObject({
      status: 200,
      body: { ok: true, value: { t3ThreadId: "t3-1" } },
    });
  });

  it("maps no lineage to 404", async () => {
    const result = await handleLhcHttpRequest(
      controller({
        inspectThread: async () => {
          throw new ClaudeSwapError({
            code: "not_captured",
            message: "not captured",
            stepReached: "resolve-lineage",
          });
        },
      }),
      { method: "GET", pathname: "/lhc/threads/missing" },
    );

    expect(result).toMatchObject({
      status: 404,
      body: { ok: false, error: { code: "not_captured", stepReached: "resolve-lineage" } },
    });
  });

  it("maps retriable and state-conflict swap errors to 409", async () => {
    for (const code of [
      "busy",
      "swap_in_progress",
      "flip_contested",
      "missing_provider_binding",
    ] as const) {
      const result = await handleLhcHttpRequest(
        controller({
          compactThread: async () => {
            throw new ClaudeSwapError({
              code,
              message: code,
              stepReached: code === "missing_provider_binding" ? "read-binding" : "busy-check",
              retriable: code !== "missing_provider_binding",
            });
          },
        }),
        { method: "POST", pathname: "/lhc/threads/t3-1/compact" },
      );

      expect(result).toMatchObject({
        status: 409,
        body: {
          ok: false,
          error: {
            code,
            stepReached: code === "missing_provider_binding" ? "read-binding" : "busy-check",
            retriable: code !== "missing_provider_binding",
          },
        },
      });
    }
  });

  it("maps disabled capture to 503", async () => {
    const result = await handleLhcHttpRequest(
      controller({
        inspectThread: async () => {
          throw new ClaudeSwapError({
            code: "capture_disabled",
            message: "disabled",
            stepReached: "resolve-lineage",
          });
        },
      }),
      { method: "GET", pathname: "/lhc/threads/t3-1" },
    );

    expect(result).toMatchObject({
      status: 503,
      body: { ok: false, error: { code: "capture_disabled", stepReached: "resolve-lineage" } },
    });
  });

  it("maps swap failures to structured 500 errors", async () => {
    const result = await handleLhcHttpRequest(
      controller({
        pruneThread: async () => {
          throw new ClaudeSwapError({
            code: "swap_failed",
            message: "boom",
            stepReached: "rebuild",
            detail: "stackless detail",
          });
        },
      }),
      { method: "POST", pathname: "/lhc/threads/t3-1/prune", body: { targetTokens: 20 } },
    );

    expect(result).toMatchObject({
      status: 500,
      body: {
        ok: false,
        error: { code: "swap_failed", stepReached: "rebuild", detail: "stackless detail" },
      },
    });
  });
});
