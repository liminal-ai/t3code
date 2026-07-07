// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SessionThreadViewEntry } from "lhc";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRolloutLines,
  formatSwapReceipt,
  receiptRolloutLines,
  serializeRolloutLines,
  sourceMetaFromContent,
} from "./rebuild.ts";
import type { RolloutLineItem } from "./types.ts";
import { rebuiltRolloutPath, writeRebuiltRollout } from "./write-rebuilt.ts";

const NEW_ID = "11111111-2222-4333-8444-555555555555";
const CWD = "/work/rebuild-test";
const FIXED_CLOCK = (): Date => new Date("2026-07-07T12:00:00.000Z");

const ENTRIES: SessionThreadViewEntry[] = [
  { role: "user", content: "[runtime note] earlier swap happened", sourceMessages: [] },
  { role: "user", content: "hello codex", sourceMessages: [] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "pondering" },
      { type: "text", text: "hi there" },
      { type: "toolCall", toolCallId: "c1", toolName: "exec_command", arguments: { cmd: "ls" } },
    ],
    sourceMessages: [],
  },
  {
    role: "toolResult",
    toolCallId: "c1",
    content: "file-a\nfile-b",
    isError: false,
    sourceMessages: [],
  },
  { role: "toolResult", toolCallId: "c2", content: "boom", isError: true, sourceMessages: [] },
  { kind: "model_change", provider: "openai", modelId: "gpt-5.5", sourceMessages: [] },
  { role: "assistant", content: [{ type: "text", text: "done" }], sourceMessages: [] },
];

function build(): ReturnType<typeof buildRolloutLines> {
  return buildRolloutLines({
    entries: ENTRIES,
    newSessionId: NEW_ID,
    cwd: CWD,
    sourceMeta: {
      sourceSessionId: "99999999-8888-4777-8666-555555555555",
      cliVersion: "0.142.5",
      baseInstructions: { text: "base" },
    },
    clock: FIXED_CLOCK,
  });
}

describe("buildRolloutLines golden shape", () => {
  it("emits the exact expected line sequence", () => {
    const kinds = build().map((entry) => [
      entry.kind,
      entry.line.type,
      (entry.line.payload as { type?: string; role?: string }).role ??
        (entry.line.payload as { type?: string }).type,
    ]);
    expect(kinds).toEqual([
      ["session_meta", "session_meta", undefined],
      ["user", "response_item", "user"], // runtime note re-serve, NO user_message event for it
      ["user", "response_item", "user"], // hello codex
      ["event", "event_msg", "user_message"], // first non-note user anchors the replay event
      ["assistant", "response_item", "assistant"],
      ["event", "event_msg", "agent_message"],
      ["user", "response_item", "user"], // tool result as plain user text
      ["user", "response_item", "user"], // tool error
      // model_change dropped
      ["assistant", "response_item", "assistant"],
      ["event", "event_msg", "agent_message"],
    ]);
  });

  it("writes a spec-complete session_meta first line", () => {
    const meta = build()[0]!.line;
    expect(meta.payload).toEqual({
      session_id: NEW_ID,
      id: NEW_ID,
      timestamp: "2026-07-07T12:00:00.000Z",
      cwd: CWD,
      originator: "codex-lhc",
      source: "exec",
      thread_source: "user",
      model_provider: "openai",
      cli_version: "0.142.5",
      base_instructions: { text: "base" },
      forked_from_id: "99999999-8888-4777-8666-555555555555",
    });
  });

  it("omits optional session_meta fields when no source meta exists", () => {
    const lines = buildRolloutLines({
      entries: [],
      newSessionId: NEW_ID,
      cwd: CWD,
      clock: FIXED_CLOCK,
    });
    expect(lines).toHaveLength(1);
    const payload = lines[0]!.line.payload as Record<string, unknown>;
    expect(payload.cli_version).toBeUndefined();
    expect(payload.base_instructions).toBeUndefined();
    expect(payload.forked_from_id).toBeUndefined();
    expect(payload.session_id).toBe(NEW_ID);
    expect(payload.id).toBe(NEW_ID);
  });

  it("renders assistant parts as one output_text and never emits tool records", () => {
    const lines = build();
    const assistant = lines.find((entry) => entry.kind === "assistant")!;
    const content = (assistant.line.payload as { content: Array<{ type: string; text: string }> })
      .content;
    expect(content).toEqual([
      {
        type: "output_text",
        text: '[thinking]\npondering\n\nhi there\n\n[tool exec_command]\n{"cmd":"ls"}',
      },
    ]);
    const types = lines.map((entry) => (entry.line.payload as { type?: string }).type);
    expect(types).not.toContain("function_call");
    expect(types).not.toContain("function_call_output");
    const toolError = lines[7]!.line.payload as { content: Array<{ text: string }> };
    expect(toolError.content[0]!.text).toBe("[tool error] boom");
  });

  it("keeps timestamps strictly increasing and serializes with trailing newline", () => {
    const lines = build();
    const stamps = lines.map((entry) => entry.line.timestamp);
    const sorted = [...stamps].sort();
    expect(stamps).toEqual(sorted);
    expect(new Set(stamps).size).toBe(stamps.length);
    const serialized = serializeRolloutLines(lines);
    expect(serialized.endsWith("\n")).toBe(true);
    for (const raw of serialized.trimEnd().split("\n")) expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe("swap receipt", () => {
  it("emits runtime-note receipt lines with response_item + event_msg twin", () => {
    const receipt = formatSwapReceipt({
      oldSessionId: "old-id",
      newSessionId: NEW_ID,
      threadId: "th_abc",
      op: "compact",
      tokensBefore: 120000,
      tokensAfter: 30000,
      expectedReplayLines: 9,
    });
    const [responseItem, eventTwin] = receiptRolloutLines(receipt, "2026-07-07T12:00:01.000Z");

    expect(responseItem!.line.type).toBe("response_item");
    const userPayload = responseItem!.line.payload as {
      role?: string;
      content?: Array<{ text?: string }>;
    };
    expect(userPayload.role).toBe("user");
    const noteText = userPayload.content?.[0]?.text ?? "";
    expect(noteText).toContain("[runtime note]");
    expect(noteText).toContain("th_abc");
    expect(noteText).toContain("compact");
    expect(noteText).toContain("120000");

    expect(eventTwin!.line.type).toBe("event_msg");
    expect((eventTwin!.line.payload as { type?: string }).type).toBe("user_message");
    expect((eventTwin!.line as RolloutLineItem).payload?.message).toBe(noteText);
  });
});

describe("sourceMetaFromContent", () => {
  it("extracts provenance fields from the first session_meta line", () => {
    const content =
      JSON.stringify({
        timestamp: "t",
        type: "session_meta",
        payload: {
          id: "src-id",
          session_id: "src-id",
          cli_version: "0.142.5",
          cwd: "/x",
          base_instructions: { text: "b" },
        },
      }) +
      "\n" +
      JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "task_started" } }) +
      "\n";
    expect(sourceMetaFromContent(content)).toEqual({
      sourceSessionId: "src-id",
      cliVersion: "0.142.5",
      baseInstructions: { text: "b" },
    });
  });

  it("is tolerant of garbage and missing meta", () => {
    expect(sourceMetaFromContent('not json\n{"type":"response_item"}\n')).toEqual({});
    expect(sourceMetaFromContent("")).toEqual({});
  });
});

describe("rebuiltRolloutPath", () => {
  it("places rollouts under CODEX_HOME/sessions/YYYY/MM/DD with local timestamp", () => {
    const when = new Date("2026-07-07T17:41:50.000Z");
    const path = rebuiltRolloutPath("/tmp/codex-home", NEW_ID, when);
    expect(path).toMatch(
      /\/tmp\/codex-home\/sessions\/2026\/07\/07\/rollout-2026-07-07T\d{2}-\d{2}-\d{2}-/,
    );
    expect(path.endsWith(`-${NEW_ID}.jsonl`)).toBe(true);
  });
});

describe("writeRebuiltRollout", () => {
  it("writes rollout with filename id matching session_meta ids", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-rebuild-"));
    const codexHome = NodePath.join(root, "codex-home");

    const result = await writeRebuiltRollout({
      view: { threadId: "th_1", entries: ENTRIES },
      cwd: CWD,
      codexHome,
      newSessionId: NEW_ID,
      clock: FIXED_CLOCK,
      readSourceFn: async () => {
        throw new Error("no source");
      },
    });

    expect(result.sessionId).toBe(NEW_ID);
    expect(result.rolloutPath).toBe(rebuiltRolloutPath(codexHome, NEW_ID, FIXED_CLOCK()));
    expect(result.lineCount).toBe(build().length);
    expect(NodeFS.existsSync(result.rolloutPath)).toBe(true);

    const lines = NodeFS.readFileSync(result.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string; payload?: Record<string, unknown> });
    expect(lines[0]?.type).toBe("session_meta");
    expect(lines[0]?.payload?.id).toBe(NEW_ID);
    expect(lines[0]?.payload?.session_id).toBe(NEW_ID);

    NodeFS.rmSync(root, { recursive: true, force: true });
  });
});
