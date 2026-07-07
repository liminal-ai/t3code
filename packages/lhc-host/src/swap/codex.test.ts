// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type Lhc,
  type MessageEventInput,
  type OpResult,
} from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { CaptureService } from "../capture/service.ts";
import type { CodexRolloutLine } from "../codex-swap/types.ts";
import {
  createCodexSwapController,
  type CodexProviderBinding,
  type CodexSwapProviderEffects,
} from "./codex.ts";
import { ClaudeSwapError } from "./claude.ts";

const OLD_THREAD_ID = "22222222-2222-4222-8222-222222222222";

function ok<T>(value: T): OpResult<T> {
  return { ok: true, value };
}

function fail(reason: string): OpResult<never> {
  return {
    ok: false,
    error: { errorClass: "system_error", code: "storage_failure", reason },
  };
}

function assertOk<T>(result: OpResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

function tempDir(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-codex-swap-test-"));
}

function sourceRolloutPath(root: string, sessionId = OLD_THREAD_ID): string {
  return NodePath.join(
    root,
    "codex-home",
    "sessions",
    "2026",
    "07",
    "07",
    `rollout-2026-07-07T12-00-00-${sessionId}.jsonl`,
  );
}

function writeSourceRollout(root: string, sessionId = OLD_THREAD_ID): string {
  const path = sourceRolloutPath(root, sessionId);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: "2026-07-07T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: sessionId,
        session_id: sessionId,
        timestamp: "2026-07-07T12:00:00.000Z",
        cwd: "/tmp/codex-project",
        originator: "codex",
        source: "vscode",
        thread_source: "user",
        model_provider: "openai",
        cli_version: "0.142.5",
      },
    })}\n`,
  );
  return path;
}

function makeFakeSdk(calls: string[], overrides: Partial<Lhc> = {}): Lhc {
  return {
    threadView: {
      compact: async () => {
        calls.push("lhc-operation");
        return ok({ viewId: "view-1", profile: "test" });
      },
      prune: async () => {
        calls.push("lhc-operation");
        return ok({ noOp: false, previousBoundary: 0, newBoundary: 1 });
      },
      getSessionThreadView: async () => {
        calls.push("render-view");
        return ok({
          entries: [
            { role: "user", content: "remember ALPHA-CODEX-42", sourceMessages: [] },
            {
              role: "assistant",
              content: [{ type: "text", text: "Stored ALPHA-CODEX-42." }],
              sourceMessages: [],
            },
          ],
        });
      },
      status: async () =>
        ok({
          tailTokens: 0,
          threshold: 160_000,
          compactRecommended: false,
          derivation: { pending: 0, retrying: 0, failed: 0, blocked: 0 },
          view: null,
          visibility: { boundaryPosition: 0, zoneTokens: 0, maxTokens: 200_000 },
        }),
    },
    intakeStream: {
      listEvents: async () => ok([]),
      messageEvents: async (_ref, events) => {
        calls.push(events[0]?.eventKind === "runtime_note" ? "runtime-note" : "intake");
        return ok({
          events: [],
          turnTransitions: [],
          queuedWork: [],
          threadPosition: { lastEventOrder: 1 },
        });
      },
    },
    inspect: {
      overview: async () =>
        ok({
          thread: { id: "lhc-1", createdAt: "2026-01-01T00:00:00.000Z" },
          events: { count: 0, span: null },
          messages: { visible: 0, byKind: {}, deleted: 0, visibleTokens: 0 },
          turns: { open: 0, closed: 0 },
          chunks: { count: 0, unchunkedTurns: 0 },
          derivation: { ready: 0, pending: 0, retrying: 0, failed: 0, blocked: 0 },
          view: null,
          visibility: { boundaryPosition: 0, zoneTokens: 0 },
        }),
      health: async () =>
        ok({ owners: [], failures: [], repairPreview: [], queue: { queued: 0, claimed: 0 } }),
    },
    ...(overrides as Partial<Lhc>),
  } as Lhc;
}

function makeCapture(sdk: Lhc): CaptureService {
  return {
    enabled: true,
    mode: "manual",
    sdk,
    handleEvent: () => {},
    noteTurnStarted: () => {},
    threadRef: () => ({ threadId: "lhc-1", registryPath: "/tmp/registry.sqlite" }),
    lookupThread: () => ({ threadId: "lhc-1", registryPath: "/tmp/registry.sqlite" }),
    listCapturedThreads: () => [
      {
        t3ThreadId: "t3-1",
        lhcThreadId: "lhc-1",
        providerKind: "codex",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    stats: () => ({
      enabled: true,
      mode: "manual",
      eventsSeen: 0,
      eventsIgnored: 0,
      global: {
        mapper: { linesSeen: 0, eventsOut: 0, malformed: 0, skips: {} },
        intake: {
          batches: 0,
          recorded: 0,
          deduped: 0,
          failedBatches: 0,
          intakeThrew: 0,
          lineageFailures: 0,
          promptsInjected: 0,
          emptyPromptsSkipped: 0,
        },
        pendingHigh: 0,
      },
      threads: [],
    }),
    onStop: () => {},
    settle: async () => {},
    stop: async () => {},
  };
}

function makeProvider(
  root: string,
  calls: string[],
  overrides: Partial<CodexSwapProviderEffects> = {},
) {
  let cursor: unknown = { threadId: OLD_THREAD_ID };
  const binding: CodexProviderBinding = {
    threadId: "t3-1",
    provider: "codex",
    providerInstanceId: "codex",
    resumeCursor: cursor,
    runtimePayload: { cwd: "/tmp/codex-project" },
    runtimeMode: "full-access",
  };
  const provider: CodexSwapProviderEffects = {
    listSessions: async () => {
      calls.push("busy-check");
      return [];
    },
    stopSession: async () => {
      calls.push("quiesce");
    },
    readBinding: async () => {
      calls.push("read-binding");
      return { ...binding, resumeCursor: cursor };
    },
    writeResumeCursor: async ({ resumeCursor }) => {
      calls.push("cursor-flip");
      cursor = resumeCursor;
    },
    resolvePaths: async () => {
      calls.push("resolve-paths");
      return {
        cwd: "/tmp/codex-project",
        codexHome: NodePath.join(root, "codex-home"),
        codexSessionsDir: NodePath.join(root, "codex-home", "sessions"),
      };
    },
    ...overrides,
  };
  return {
    provider,
    getCursor: () => cursor,
    setCursor: (next: unknown) => {
      cursor = next;
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function parseRolloutLines(path: string): CodexRolloutLine[] {
  return NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CodexRolloutLine);
}

let root: string;

beforeEach(() => {
  root = tempDir();
  writeSourceRollout(root);
});

afterEach(() => {
  NodeFS.rmSync(root, { recursive: true, force: true });
});

describe("Codex swap orchestration", () => {
  it("flips the bare threadId cursor after quiesce and rebuild on the happy path", async () => {
    const calls: string[] = [];
    const sdk = makeFakeSdk(calls);
    const { provider, getCursor } = makeProvider(root, calls);
    const controller = createCodexSwapController({ capture: makeCapture(sdk), provider });

    const receipt = await controller.compactThread("t3-1");

    expect(receipt.oldSessionId).toBe(OLD_THREAD_ID);
    expect(receipt.cursor).toEqual({ threadId: receipt.newSessionId });
    expect(getCursor()).toEqual(receipt.cursor);
    expect(NodeFS.existsSync(receipt.rebuiltPath)).toBe(true);
    expect(NodePath.basename(receipt.rebuiltPath)).toContain(receipt.newSessionId);
    expect(calls).toEqual([
      "busy-check",
      "read-binding",
      "lhc-operation",
      "render-view",
      "quiesce",
      "resolve-paths",
      "busy-check",
      "cursor-flip",
      "read-binding",
      "runtime-note",
    ]);
    expect(calls.indexOf("cursor-flip")).toBeGreaterThan(calls.indexOf("quiesce"));
  });

  it("rejects an in-flight turn without touching the cursor", async () => {
    const calls: string[] = [];
    const { provider, getCursor } = makeProvider(root, calls, {
      listSessions: async () => [{ threadId: "t3-1", provider: "codex", activeTurnId: "turn-1" }],
    });
    const controller = createCodexSwapController({
      capture: makeCapture(makeFakeSdk(calls)),
      provider,
    });

    await expect(controller.compactThread("t3-1")).rejects.toMatchObject({
      code: "busy",
      stepReached: "busy-check",
      retriable: true,
    });
    expect(getCursor()).toEqual({ threadId: OLD_THREAD_ID });
  });

  it("leaves the cursor untouched for failures before the flip", async () => {
    const cases: Array<{
      name: string;
      make: () => {
        sdk?: Lhc;
        provider?: Partial<CodexSwapProviderEffects>;
        stat?: typeof NodeFS.promises.stat;
      };
    }> = [
      {
        name: "lhc operation",
        make: () => ({
          sdk: makeFakeSdk([], {
            threadView: {
              compact: async () => fail("compact failed"),
              getSessionThreadView: async () => ok({ entries: [] }),
              status: async () => ok({ visibility: { boundaryPosition: 0, zoneTokens: 0 } }),
            } as unknown as Lhc["threadView"],
          }),
        }),
      },
      {
        name: "render view",
        make: () => ({
          sdk: makeFakeSdk([], {
            threadView: {
              compact: async () => ok({ viewId: "view-1" }),
              getSessionThreadView: async () => fail("view failed"),
              status: async () => ok({ visibility: { boundaryPosition: 0, zoneTokens: 0 } }),
            } as unknown as Lhc["threadView"],
          }),
        }),
      },
      {
        name: "quiesce",
        make: () => ({
          provider: {
            stopSession: async () => {
              throw new Error("stop");
            },
          },
        }),
      },
      {
        name: "paths",
        make: () => ({
          provider: {
            resolvePaths: async () => {
              throw new Error("paths");
            },
          },
        }),
      },
      {
        name: "preflip validate",
        make: () => ({
          stat: async () => {
            throw new Error("stat");
          },
        }),
      },
      {
        name: "cursor write",
        make: () => ({
          provider: {
            writeResumeCursor: async () => {
              throw new Error("write");
            },
          },
        }),
      },
    ];

    for (const testCase of cases) {
      const calls: string[] = [];
      const built = testCase.make();
      const { provider, getCursor } = makeProvider(root, calls, built.provider);
      const controller = createCodexSwapController({
        capture: makeCapture(built.sdk ?? makeFakeSdk(calls)),
        provider,
        ...(built.stat ? { stat: built.stat } : {}),
      });

      await expect(controller.compactThread("t3-1")).rejects.toBeInstanceOf(ClaudeSwapError);
      expect(getCursor(), testCase.name).toEqual({ threadId: OLD_THREAD_ID });
    }
  });

  it("reports a contested flip when a provider cursor write lands after the swap flip", async () => {
    const calls: string[] = [];
    let writes = 0;
    let setCursor: (next: unknown) => void = () => {};
    const staleCursor = { threadId: OLD_THREAD_ID };
    const built = makeProvider(root, calls, {
      listSessions: async () => {
        calls.push("busy-check");
        return writes > 0
          ? [{ threadId: "t3-1", provider: "codex", activeTurnId: "turn-race" }]
          : [];
      },
      writeResumeCursor: async ({ resumeCursor }) => {
        calls.push("cursor-flip");
        writes += 1;
        setCursor(resumeCursor);
        setCursor(staleCursor);
      },
    });
    setCursor = built.setCursor;
    const controller = createCodexSwapController({
      capture: makeCapture(makeFakeSdk(calls)),
      provider: built.provider,
    });

    await expect(controller.compactThread("t3-1")).rejects.toMatchObject({
      code: "flip_contested",
      stepReached: "cursor-flip",
      retriable: true,
      detail: expect.stringContaining("turn-race"),
    });
    expect(built.getCursor()).toEqual(staleCursor);
  });

  it("retries the cursor flip once when an idle stale write is observed", async () => {
    const calls: string[] = [];
    let writes = 0;
    let setCursor: (next: unknown) => void = () => {};
    const staleCursor = { threadId: OLD_THREAD_ID };
    const built = makeProvider(root, calls, {
      listSessions: async () => {
        calls.push("busy-check");
        return [];
      },
      writeResumeCursor: async ({ resumeCursor }) => {
        calls.push("cursor-flip");
        writes += 1;
        setCursor(resumeCursor);
        if (writes === 1) setCursor(staleCursor);
      },
    });
    setCursor = built.setCursor;
    const controller = createCodexSwapController({
      capture: makeCapture(makeFakeSdk(calls)),
      provider: built.provider,
    });

    const receipt = await controller.compactThread("t3-1");

    expect(writes).toBe(2);
    expect(built.getCursor()).toEqual(receipt.cursor);
    expect(receipt.cursor.threadId).toBe(receipt.newSessionId);
  });

  it("serializes swaps per thread", async () => {
    const calls: string[] = [];
    let releaseQuiesce: (() => void) | undefined;
    const quiesceGate = new Promise<void>((resolve) => {
      releaseQuiesce = resolve;
    });
    const { provider } = makeProvider(root, calls, {
      stopSession: async () => {
        calls.push("quiesce");
        await quiesceGate;
      },
    });
    const controller = createCodexSwapController({
      capture: makeCapture(makeFakeSdk(calls)),
      provider,
    });

    const first = controller.compactThread("t3-1");
    await waitUntil(() => calls.includes("quiesce"));

    await expect(controller.compactThread("t3-1")).rejects.toMatchObject({
      code: "swap_in_progress",
      stepReached: "busy-check",
      retriable: true,
    });

    releaseQuiesce?.();
    await expect(first).resolves.toMatchObject({ op: "compact", t3ThreadId: "t3-1" });
  });

  it("lets different threads run concurrently while one swap is parked", async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { provider } = makeProvider(root, calls, {
      stopSession: async () => {
        calls.push("quiesce");
        await wait;
      },
    });
    const capture = makeCapture(makeFakeSdk(calls));
    const controller = createCodexSwapController({ capture, provider });

    const first = controller.compactThread("t3-1");
    await waitUntil(() => calls.includes("quiesce"));
    const other = controller.compactThread("t3-2").catch((cause) => cause);
    release?.();
    await first;
    const otherResult = await other;
    expect(otherResult).not.toMatchObject({ code: "swap_in_progress" });
  });
});

describe("Codex swap with real LHC SDK", () => {
  it("runs a real compact, rebuilds a rollout, flips cursor, and preserves rollout id invariants", async () => {
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });
    const registryPath = NodePath.join(root, "registry.sqlite");
    const threadPath = NodePath.join(root, "thread.sqlite");
    const created = assertOk(await sdk.threads.newThread({ filePath: threadPath, registryPath }));
    const ref = { threadId: created.threadId, registryPath };
    const events: MessageEventInput[] = [];
    for (let index = 0; index < 8; index += 1) {
      events.push(
        {
          eventKind: "user_prompt",
          idempotencyKey: `u-${index}`,
          actor: "test",
          harness: "t3",
          payload: { text: `codex question ${index} ${"x".repeat(80)}` },
        },
        {
          eventKind: "assistant_text",
          idempotencyKey: `a-${index}`,
          actor: "test",
          harness: "t3",
          payload: { text: `codex answer ${index} ${"y".repeat(80)}` },
        },
        {
          eventKind: "turn_end",
          idempotencyKey: `e-${index}`,
          actor: "test",
          harness: "t3",
          payload: {},
        },
      );
    }
    assertOk(await sdk.intakeStream.messageEvents(ref, events));

    const calls: string[] = [];
    const { provider, getCursor } = makeProvider(root, calls);
    const capture = {
      ...makeCapture(sdk),
      lookupThread: () => ref,
      listCapturedThreads: () => [
        {
          t3ThreadId: "t3-1",
          lhcThreadId: created.threadId,
          providerKind: "codex",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    const controller = createCodexSwapController({ capture, provider });

    const receipt = await controller.compactThread("t3-1", {
      params: { lowerBound: 120, percentages: { full: 25, smooth: 25, detailed: 25, brief: 25 } },
    });

    expect(receipt.lhcResult).toMatchObject({ totalTokens: expect.any(Number) });
    expect(getCursor()).toEqual({ threadId: receipt.newSessionId });
    const lines = parseRolloutLines(receipt.rebuiltPath);
    const first = lines[0]!;
    expect(first.type).toBe("session_meta");
    expect(first.payload.id).toBe(receipt.newSessionId);
    expect(first.payload.session_id).toBe(receipt.newSessionId);
    expect(NodePath.basename(receipt.rebuiltPath)).toContain(receipt.newSessionId);
    expect(receipt.rebuilt.expectedReintakeLines).toBe(lines.length);
  });
});
