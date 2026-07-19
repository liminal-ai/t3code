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

import type { RolloutLineItem } from "./types.ts";
import { encodeProjectPath, writeRebuiltRollout } from "./write-rebuilt.ts";

interface TempStore {
  dir: string;
  registryPath: string;
  threadPath: string;
  claudeHome: string;
  claudeProjectsDir: string;
  cwd: string;
  cleanup: () => void;
}

function tempStore(): TempStore {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-rebuild-"));
  const claudeHome = NodePath.join(dir, "claude-home");
  const claudeProjectsDir = NodePath.join(claudeHome, ".claude", "projects");
  const cwd = NodePath.join(dir, "work-repo");
  NodeFS.mkdirSync(cwd, { recursive: true });
  return {
    dir,
    registryPath: NodePath.join(dir, "registry.sqlite"),
    threadPath: NodePath.join(dir, "thread.sqlite"),
    claudeHome,
    claudeProjectsDir,
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

function parseRolloutLines(content: string): RolloutLineItem[] {
  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RolloutLineItem);
}

function assertRolloutInvariants(
  lines: RolloutLineItem[],
  sessionId: string,
  rolloutPath: string,
): void {
  expect(NodePath.basename(rolloutPath)).toBe(`${sessionId}.jsonl`);

  let previousUuid: string | null = null;
  for (const [index, line] of lines.entries()) {
    expect(line.type === "user" || line.type === "assistant").toBe(true);
    expect(typeof line.uuid).toBe("string");
    expect(line.sessionId).toBe(sessionId);
    expect(line.isSidechain).toBe(false);
    expect(typeof line.cwd).toBe("string");
    expect(typeof line.timestamp).toBe("string");

    if (index === 0) {
      expect(line.parentUuid).toBeNull();
    } else {
      expect(line.parentUuid).toBe(previousUuid);
    }
    previousUuid = line.uuid ?? null;
  }
}

let store: TempStore;

beforeEach(() => {
  store = tempStore();
});

afterEach(() => {
  store.cleanup();
});

describe("writeRebuiltRollout from real SessionThreadView", () => {
  it("rebuilds rollout JSONL from an LHC thread view with valid session and parent chain", async () => {
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
    const result = await writeRebuiltRollout({
      view,
      cwd: store.cwd,
      claudeProjectsDir: store.claudeProjectsDir,
      newSessionId,
    });

    const resolvedCwd = NodeFS.realpathSync.native(store.cwd);
    const expectedPath = NodePath.join(
      store.claudeProjectsDir,
      encodeProjectPath(resolvedCwd),
      `${newSessionId}.jsonl`,
    );
    expect(result.rolloutPath).toBe(expectedPath);
    expect(NodeFS.existsSync(result.rolloutPath)).toBe(true);

    const lines = parseRolloutLines(NodeFS.readFileSync(result.rolloutPath, "utf8"));
    expect(lines.length).toBe(result.lineCount);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    assertRolloutInvariants(lines, newSessionId, result.rolloutPath);

    const userLines = lines.filter((line) => line.type === "user");
    const assistantLines = lines.filter((line) => line.type === "assistant");
    expect(userLines.length).toBeGreaterThanOrEqual(1);
    expect(assistantLines.length).toBeGreaterThanOrEqual(1);
    expect(userLines[0]?.message?.content).toContain("deployment codename");
  });

  it("re-emits tool activity as NATIVE blocks end-to-end (thinking / tool_use / tool_result)", async () => {
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

    const toolBatch: MessageEventInput[] = [
      {
        eventKind: "user_prompt",
        idempotencyKey: "tool-user-1",
        actor: "a",
        harness: "h",
        payload: { text: "list the repo files" },
      },
      {
        eventKind: "assistant_thinking",
        idempotencyKey: "tool-think-1",
        actor: "a",
        harness: "h",
        payload: { text: "I should run ls." },
      },
      {
        eventKind: "tool_call",
        idempotencyKey: "tool-call-1",
        actor: "a",
        harness: "h",
        payload: { toolCallId: "toolu_e2e_01", toolName: "Bash", arguments: { command: "ls" } },
      },
      {
        eventKind: "tool_result",
        idempotencyKey: "tool-result-1",
        actor: "tool",
        harness: "h",
        payload: { toolCallId: "toolu_e2e_01", content: "a.ts\nb.ts", isError: false },
      },
      {
        eventKind: "assistant_text",
        idempotencyKey: "tool-text-1",
        actor: "a",
        harness: "h",
        payload: { text: "Two files." },
      },
      {
        eventKind: "turn_end",
        idempotencyKey: "tool-turn-end-1",
        actor: "a",
        harness: "h",
        payload: {},
      },
    ];
    assertOk(await sdk.intakeStream.messageEvents({ filePath: created.filePath }, toolBatch));

    const view = assertOk(
      await sdk.threadView.getSessionThreadView({ filePath: created.filePath }),
    );
    const newSessionId = "b2c3d4e5-f607-4890-a123-456789abcdef";
    const result = await writeRebuiltRollout({
      view,
      cwd: store.cwd,
      claudeProjectsDir: store.claudeProjectsDir,
      newSessionId,
    });

    const lines = parseRolloutLines(NodeFS.readFileSync(result.rolloutPath, "utf8"));
    assertRolloutInvariants(lines, newSessionId, result.rolloutPath);
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain("[tool ");
    expect(serialized).not.toContain("[thinking]");

    const blocks = lines.flatMap((line) =>
      Array.isArray(line.message?.content) ? line.message.content : [],
    );
    expect(blocks.find((b) => b.type === "thinking")).toMatchObject({
      thinking: "I should run ls.",
      signature: "",
    });
    expect(blocks.find((b) => b.type === "tool_use")).toMatchObject({
      id: "toolu_e2e_01",
      name: "Bash",
      input: { command: "ls" },
    });
    expect(blocks.find((b) => b.type === "tool_result")).toMatchObject({
      tool_use_id: "toolu_e2e_01",
      content: "a.ts\nb.ts",
      is_error: false,
    });
  });
});
