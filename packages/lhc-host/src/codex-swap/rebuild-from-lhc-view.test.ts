// @effect-diagnostics nodeBuiltinImport:off globalDate:off
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

import type { CodexRolloutLine } from "./types.ts";
import { rebuiltRolloutPath, writeRebuiltRollout } from "./write-rebuilt.ts";

interface TempStore {
  dir: string;
  registryPath: string;
  threadPath: string;
  codexHome: string;
  cwd: string;
  cleanup: () => void;
}

function tempStore(): TempStore {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-codex-rebuild-"));
  const codexHome = NodePath.join(dir, "codex-home");
  const cwd = NodePath.join(dir, "work-repo");
  NodeFS.mkdirSync(cwd, { recursive: true });
  return {
    dir,
    registryPath: NodePath.join(dir, "registry.sqlite"),
    threadPath: NodePath.join(dir, "thread.sqlite"),
    codexHome,
    cwd,
    cleanup: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
}

function intakeBatch(): MessageEventInput[] {
  return [
    {
      eventKind: "user_prompt",
      idempotencyKey: "rebuild-user-1",
      actor: "rebuild-actor",
      harness: "rebuild-harness",
      payload: { text: "What is the deployment codename?" },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: "rebuild-assistant-1",
      actor: "rebuild-actor",
      harness: "rebuild-harness",
      payload: { text: "The codename is BRONZE-HERON-77." },
    },
    {
      eventKind: "turn_end",
      idempotencyKey: "rebuild-turn-end-1",
      actor: "rebuild-actor",
      harness: "rebuild-harness",
      payload: {},
    },
    {
      eventKind: "user_prompt",
      idempotencyKey: "rebuild-user-2",
      actor: "rebuild-actor",
      harness: "rebuild-harness",
      payload: { text: "Confirm the deployment codename." },
    },
    {
      eventKind: "assistant_text",
      idempotencyKey: "rebuild-assistant-2",
      actor: "rebuild-actor",
      harness: "rebuild-harness",
      payload: { text: "Confirmed: BRONZE-HERON-77." },
    },
    {
      eventKind: "turn_end",
      idempotencyKey: "rebuild-turn-end-2",
      actor: "rebuild-actor",
      harness: "rebuild-harness",
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

function parseRolloutLines(content: string): CodexRolloutLine[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as CodexRolloutLine);
}

function sessionIdFromFilename(rolloutPath: string): string {
  const base = NodePath.basename(rolloutPath, ".jsonl");
  const match = base.match(/^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/);
  if (match?.[1] === undefined) {
    throw new Error(`rollout filename does not match expected pattern: ${base}`);
  }
  return match[1];
}

function assertCodexRolloutInvariants(
  lines: CodexRolloutLine[],
  sessionId: string,
  rolloutPath: string,
  cwd: string,
): void {
  expect(lines.length).toBeGreaterThanOrEqual(1);

  const filenameId = sessionIdFromFilename(rolloutPath);
  expect(filenameId).toBe(sessionId);

  const first = lines[0]!;
  expect(first.type).toBe("session_meta");
  const meta = first.payload;
  expect(meta.id).toBe(sessionId);
  expect(meta.session_id).toBe(sessionId);
  expect(meta.cwd).toBe(cwd);

  for (const [index, line] of lines.entries()) {
    expect(typeof line.timestamp).toBe("string");
    expect(["session_meta", "response_item", "event_msg"]).toContain(line.type);
    expect(() => JSON.stringify(line)).not.toThrow();
    if (index > 0) {
      expect(line.type).not.toBe("session_meta");
    }
  }

  const responseItems = lines.filter((line) => line.type === "response_item");
  const eventMsgs = lines.filter((line) => line.type === "event_msg");
  expect(responseItems.length).toBeGreaterThanOrEqual(2);
  expect(eventMsgs.length).toBeGreaterThanOrEqual(1);

  const userItem = responseItems.find(
    (line) => (line.payload as { role?: string }).role === "user",
  );
  const assistantItem = responseItems.find(
    (line) => (line.payload as { role?: string }).role === "assistant",
  );
  expect(userItem).toBeDefined();
  expect(assistantItem).toBeDefined();

  const userText = (
    (userItem!.payload as { content?: Array<{ text?: string }> }).content?.[0] as
      | { text?: string }
      | undefined
  )?.text;
  expect(typeof userText).toBe("string");
  expect(userText).toContain("deployment codename");

  const userEvent = eventMsgs.find(
    (line) => (line.payload as { type?: string }).type === "user_message",
  );
  const agentEvent = eventMsgs.find(
    (line) => (line.payload as { type?: string }).type === "agent_message",
  );
  expect(userEvent).toBeDefined();
  expect(agentEvent).toBeDefined();
  expect((userEvent!.payload as { message?: string }).message).toBe(userText);
}

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});

afterEach(() => {
  store.cleanup();
});

describe("writeRebuiltRollout from real SessionThreadView", () => {
  it("rebuilds codex rollout JSONL from an LHC thread view with resume invariants", async () => {
    const sdk = initLhc({
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    });

    const created = assertOk(
      await sdk.threads.newThread({
        filePath: store.threadPath,
        registryPath: store.registryPath,
      }),
    );

    assertOk(await sdk.intakeStream.messageEvents({ filePath: created.filePath }, intakeBatch()));

    const view = assertOk(
      await sdk.threadView.getSessionThreadView({ filePath: created.filePath }),
    );
    expect(view.entries.length).toBeGreaterThanOrEqual(2);

    const newSessionId = "a1b2c3d4-e5f6-4789-a012-3456789abcde";
    const clock = (): Date => new Date("2026-07-07T12:00:00.000Z");
    const result = await writeRebuiltRollout({
      view,
      cwd: store.cwd,
      codexHome: store.codexHome,
      newSessionId,
      clock,
    });

    const expectedPath = rebuiltRolloutPath(store.codexHome, newSessionId, clock());
    expect(result.rolloutPath).toBe(expectedPath);
    expect(NodeFS.existsSync(result.rolloutPath)).toBe(true);

    const lines = parseRolloutLines(NodeFS.readFileSync(result.rolloutPath, "utf8"));
    expect(lines.length).toBe(result.lineCount);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    assertCodexRolloutInvariants(lines, newSessionId, result.rolloutPath, store.cwd);
  });
});
