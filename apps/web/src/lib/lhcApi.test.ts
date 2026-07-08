import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";

import {
  __resetLhcRoutesUnavailableForTests,
  fetchLhcThreadInspect,
  formatLhcActionError,
  formatLhcSuccessToast,
  isLhcRoutesUnavailable,
  LhcApiError,
  postLhcCompact,
} from "./lhcApi";

describe("lhcApi", () => {
  const threadId = ThreadId.make("thread-1");

  afterEach(() => {
    __resetLhcRoutesUnavailableForTests();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(globalThis, "window");
  });

  function stubPrimaryBrowserFetch(fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "http://127.0.0.1:4601/",
          origin: "http://127.0.0.1:4601",
        },
      },
    });
  }

  it("parses inspect success responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          value: {
            t3ThreadId: "thread-1",
            lhcThreadId: "lhc-1",
            providerKind: "claudeAgent",
            tailTokens: 940_055,
            compactRecommended: true,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    stubPrimaryBrowserFetch(fetchMock);

    await expect(fetchLhcThreadInspect(threadId, fetchMock)).resolves.toEqual({
      t3ThreadId: "thread-1",
      lhcThreadId: "lhc-1",
      providerKind: "claudeAgent",
      tailTokens: 940_055,
      compactRecommended: true,
    });
  });

  it("maps 404 not_captured errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "not_captured",
            message: "missing lineage",
            stepReached: "resolve-lineage",
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      ),
    );
    stubPrimaryBrowserFetch(fetchMock);

    await expect(fetchLhcThreadInspect(ThreadId.make("missing"), fetchMock)).rejects.toMatchObject({
      status: 404,
      code: "not_captured",
      stepReached: "resolve-lineage",
    });
    expect(isLhcRoutesUnavailable()).toBe(false);
  });

  it("latches unavailable on non-JSON 404 and skips later fetches", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("<html>not found</html>", { status: 404 }))
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true, value: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    stubPrimaryBrowserFetch(fetchMock);

    await expect(fetchLhcThreadInspect(threadId, fetchMock)).rejects.toMatchObject({
      status: 404,
      code: "invalid_response",
    });
    expect(isLhcRoutesUnavailable()).toBe(true);

    await expect(fetchLhcThreadInspect(threadId, fetchMock)).rejects.toMatchObject({
      code: "lhc_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("latches unavailable on network errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    stubPrimaryBrowserFetch(fetchMock);

    await expect(fetchLhcThreadInspect(threadId, fetchMock)).rejects.toBeInstanceOf(TypeError);
    expect(isLhcRoutesUnavailable()).toBe(true);
  });

  it("maps 409 busy errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "busy",
            message: "turn active",
            stepReached: "busy-check",
          },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      ),
    );
    stubPrimaryBrowserFetch(fetchMock);

    await expect(postLhcCompact(threadId, fetchMock)).rejects.toMatchObject({
      status: 409,
      code: "busy",
      stepReached: "busy-check",
    });
  });

  it("formats structured action errors", () => {
    expect(
      formatLhcActionError(
        new LhcApiError({ status: 409, code: "busy", stepReached: "busy-check" }),
      ),
    ).toBe("Wait for the current turn to finish");
    expect(
      formatLhcActionError(
        new LhcApiError({ status: 409, code: "flip_contested", stepReached: "cursor-flip" }),
      ),
    ).toBe("Contested — try again");
    expect(
      formatLhcActionError(
        new LhcApiError({ status: 500, code: "swap_failed", stepReached: "rebuild" }),
      ),
    ).toBe("swap_failed (rebuild)");
  });

  it("formats success toasts with lhcResult token details", () => {
    expect(
      formatLhcSuccessToast("compact", {
        op: "compact",
        lhcResult: { zoneTokensAfter: 9_500, totalTokens: 18_000 },
      }),
    ).toEqual({
      title: "Compacted — new session ready",
      description: "9.5k zone tokens · 18k total",
    });
  });
});
