// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SessionThreadView, SessionThreadViewEntry } from "lhc";
import { describe, expect, it } from "vite-plus/test";

import {
  buildRolloutLines,
  envelopeFromRolloutLine,
  firstUserPrompt,
  parseRolloutEnvelopeFromContent,
  serializeRolloutLines,
} from "./rebuild.ts";
import { encodeProjectPath, writeRebuiltRollout } from "./write-rebuilt.ts";

const sampleEntries: SessionThreadViewEntry[] = [
  { role: "user", content: "hello", sourceMessages: [] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "hi there" },
    ],
    sourceMessages: [],
  },
  {
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "Bash",
    content: "output",
    sourceMessages: [],
  },
];

function fixturePath(relativePath: string): string {
  return NodePath.join(
    import.meta.dirname,
    "../../test/fixtures/claude-swap-rebuild",
    relativePath,
  );
}

describe("buildRolloutLines", () => {
  it("maps view entries to uuid-linked rollout lines with envelope fields", () => {
    const sessionId = "new-session-id";
    const lines = buildRolloutLines({
      entries: sampleEntries,
      newSessionId: sessionId,
      envelope: {
        cwd: "/work/project",
        version: "2.1.201",
        gitBranch: "main",
        assistantModel: "claude-opus-4-6",
        dualSessionIdFields: true,
      },
    });

    expect(lines).toHaveLength(3);
    expect(lines[0]?.line.parentUuid).toBeNull();
    expect(lines[1]?.line.parentUuid).toBe(lines[0]?.line.uuid);
    expect(lines[2]?.line.parentUuid).toBe(lines[1]?.line.uuid);
    for (const entry of lines) {
      expect(entry.line.sessionId).toBe(sessionId);
      expect(entry.line.session_id).toBe(sessionId);
      expect(entry.line.cwd).toBe("/work/project");
      expect(entry.line.version).toBe("2.1.201");
      expect(entry.line.isSidechain).toBe(false);
    }
    expect(lines[0]?.line.type).toBe("user");
    expect(lines[0]?.line.message?.content).toBe("hello");
    expect(lines[1]?.line.type).toBe("assistant");
    expect(lines[1]?.line.message).toMatchObject({
      role: "assistant",
      type: "message",
      model: "claude-opus-4-6",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "[thinking]\nhmm\n\nhi there" }],
    });
    expect(typeof lines[1]?.line.message?.id).toBe("string");
    expect(String(lines[1]?.line.message?.id)).toMatch(/^msg_/);
    expect(lines[2]?.line.type).toBe("user");
    expect(lines[2]?.line.message?.content).toBe("output");
  });

  it("serializes one JSON object per line", () => {
    const lines = buildRolloutLines({
      entries: [{ role: "user", content: "one", sourceMessages: [] }],
      newSessionId: "sid",
      envelope: { cwd: "/w" },
    });
    const serialized = serializeRolloutLines(lines);
    const parsed = serialized
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type?: string });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.type).toBe("user");
  });
});

describe("parseRolloutEnvelopeFromContent", () => {
  it("copies envelope scalars and assistant model from source rollout", () => {
    const content = NodeFS.readFileSync(fixturePath("source-rollout.jsonl"), "utf8");
    const envelope = parseRolloutEnvelopeFromContent(content, "/work/project");
    expect(envelope.version).toBe("2.1.201");
    expect(envelope.gitBranch).toBe("main");
    expect(envelope.dualSessionIdFields).toBe(true);
    expect(envelope.assistantModel).toBe("claude-sonnet-4-6");
  });

  it("detects dual session id fields from a rollout line", () => {
    const envelope = envelopeFromRolloutLine({ type: "user", session_id: "abc", cwd: "/w" }, "/w");
    expect(envelope.dualSessionIdFields).toBe(true);
  });
});

describe("encodeProjectPath", () => {
  it("replaces non-alphanumeric path segments with dashes", () => {
    expect(encodeProjectPath("/work/project")).toBe("-work-project");
    expect(encodeProjectPath("/private/var/folders/tmp")).toBe("-private-var-folders-tmp");
  });
});

describe("writeRebuiltRollout", () => {
  it("writes rollout file with envelope from source and realpath-encoded project dir", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lhc-rebuild-"));
    const claudeHome = NodePath.join(root, "claude-home");
    const claudeProjectsDir = NodePath.join(claudeHome, ".claude", "projects");
    const cwd = NodePath.join(root, "work", "project");
    NodeFS.mkdirSync(cwd, { recursive: true });
    const resolvedCwd = NodeFS.realpathSync.native(cwd);
    const projectDir = NodePath.join(claudeProjectsDir, encodeProjectPath(resolvedCwd));
    NodeFS.mkdirSync(projectDir, { recursive: true });

    const sourcePath = NodePath.join(projectDir, "source.jsonl");
    NodeFS.writeFileSync(
      sourcePath,
      NodeFS.readFileSync(fixturePath("source-rollout.jsonl"), "utf8"),
    );

    const view: SessionThreadView = {
      threadId: "th_1",
      entries: sampleEntries,
    };

    const result = await writeRebuiltRollout({
      view,
      cwd,
      newSessionId: "rebuilt-session",
      claudeProjectsDir,
      sourceRolloutPath: sourcePath,
    });

    expect(NodeFS.existsSync(result.rolloutPath)).toBe(true);
    expect(result.lineCount).toBe(3);
    expect(result.rolloutPath).toBe(NodePath.join(projectDir, "rebuilt-session.jsonl"));

    const rolloutContent = NodeFS.readFileSync(result.rolloutPath, "utf8");
    const parsedLines = rolloutContent
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { version?: string; message?: { content?: string } });
    expect(parsedLines).toHaveLength(3);
    expect(parsedLines[0]?.version).toBe("2.1.201");
    expect(parsedLines[0]?.message?.content).toBe("hello");
    expect(
      firstUserPrompt(
        buildRolloutLines({
          entries: sampleEntries,
          newSessionId: "rebuilt-session",
          envelope: { cwd: resolvedCwd, version: "2.1.201" },
        }),
      ),
    ).toBe("hello");
  });

  it("appends the swap receipt as a trailing runtime-note user line when requested", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-lhc-rebuild-receipt-"));
    const claudeProjectsDir = NodePath.join(root, ".claude", "projects");

    const result = await writeRebuiltRollout({
      view: { threadId: "th_1", entries: sampleEntries },
      cwd: "/work/project",
      newSessionId: "rebuilt-session",
      claudeProjectsDir,
      swapReceipt: { oldSessionId: "old-session" },
    });

    // The receipt line is part of the rebuilt file, so it counts as a replayed line.
    expect(result.lineCount).toBe(4);
    expect(result.expectedReintakeLines).toBe(4);
    // ...but it is NEW history, not served-view replay: the handoff capture
    // must map it (as runtime_note) instead of hard-skipping it as prefix.
    expect(result.replayedPrefixLines).toBe(3);

    const lines = NodeFS.readFileSync(result.rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            type?: string;
            uuid?: string;
            parentUuid?: string | null;
            message?: { content?: unknown };
          },
      );
    expect(lines).toHaveLength(4);
    const receipt = lines[3]!;
    expect(receipt.type).toBe("user");
    expect(receipt.parentUuid).toBe(lines[2]!.uuid);
    expect(receipt.message?.content).toBe(
      "[runtime note] session old-session preserved; resumed in-place as rebuilt-session (expect ~4 replayed lines to re-intake)",
    );
  });
});
