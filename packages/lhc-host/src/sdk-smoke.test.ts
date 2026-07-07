// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  createDeterministicInferenceCallbacks,
  initLhc,
  type MessageEventInput,
  type OpResult,
} from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

interface TempStore {
  dir: string;
  registryPath: string;
  threadPath: string;
  cleanup: () => void;
}

function tempStore(): TempStore {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-smoke-"));
  return {
    dir,
    registryPath: NodePath.join(dir, "registry.sqlite"),
    threadPath: NodePath.join(dir, "thread.sqlite"),
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

function smokeBatch(): MessageEventInput[] {
  return [
    {
      eventKind: "user_prompt",
      idempotencyKey: "smoke-user-1",
      actor: "smoke-actor",
      harness: "smoke-harness",
      payload: { text: "hello from lhc-host smoke test" },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: "smoke-assistant-1",
      actor: "smoke-actor",
      harness: "smoke-harness",
      payload: { text: "acknowledged" },
    },
    {
      eventKind: "turn_end",
      idempotencyKey: "smoke-turn-end-1",
      actor: "smoke-actor",
      harness: "smoke-harness",
      payload: {},
    },
  ];
}

function assertOk<T>(result: OpResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.reason);
  }
  return result.value;
}

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});

afterEach(() => {
  store.cleanup();
});

describe("lhc SDK smoke", () => {
  it("links, intakes events, lists messages, and skips duplicate idempotency keys", async () => {
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });

    const created = await sdk.threads.newThread({
      filePath: store.threadPath,
      registryPath: store.registryPath,
    });
    const { filePath } = assertOk(created);

    const batch = smokeBatch();
    const first = await sdk.intakeStream.messageEvents({ filePath }, batch);
    const firstResult = assertOk(first);
    expect(firstResult.events.map((entry) => entry.outcome)).toEqual([
      "recorded",
      "recorded",
      "recorded",
    ]);

    const listed = await sdk.messages.list({ filePath });
    const messages = assertOk(listed);
    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.kind)).toEqual(["user_prompt", "assistant_text"]);

    const resend = await sdk.intakeStream.messageEvents({ filePath }, batch);
    const resendResult = assertOk(resend);
    expect(resendResult.events).toHaveLength(3);
    for (const [index, entry] of resendResult.events.entries()) {
      expect(entry.outcome).toBe("skipped");
      expect(entry.skipReason).toBe("duplicate_idempotency_key");
      expect(entry.idempotencyKey).toBe(batch[index]!.idempotencyKey);
    }

    const listedAgain = await sdk.messages.list({ filePath });
    const messagesAgain = assertOk(listedAgain);
    expect(messagesAgain).toHaveLength(2);
    expect(messagesAgain.map((message) => message.kind)).toEqual(["user_prompt", "assistant_text"]);
  });
});
