// @effect-diagnostics globalDate:off
import type { SessionThreadView, SessionThreadViewEntry } from "lhc";
import { describe, expect, it } from "vite-plus/test";

import { buildRolloutLines as buildClaudeRolloutLines } from "../claude-swap/rebuild.ts";
import { buildRolloutLines as buildCodexRolloutLines } from "../codex-swap/rebuild.ts";
import {
  dumpClaudeRolloutLines,
  dumpCodexRolloutLines,
  dumpSessionThreadView,
  parseRolloutContent,
  stableJson,
} from "./transcript-dump.ts";

const toolHeavyEntries: SessionThreadViewEntry[] = [
  { role: "user", content: "please list files", sourceMessages: [] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "need ls" },
      { type: "text", text: "Listing now." },
      {
        type: "toolCall",
        toolCallId: "toolu_01AB",
        toolName: "Bash",
        arguments: { command: "ls", description: "List" },
      },
    ],
    sourceMessages: [],
  },
  {
    role: "toolResult",
    toolCallId: "toolu_01AB",
    toolName: "Bash",
    content: "a.ts\nb.ts",
    sourceMessages: [],
  },
  {
    role: "toolResult",
    toolCallId: "toolu_02",
    content: "boom",
    isError: true,
    sourceMessages: [],
  },
  { role: "assistant", content: [{ type: "text", text: "Two files." }], sourceMessages: [] },
];

describe("stableJson", () => {
  it("sorts keys recursively so structural equality is byte equality", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe(
      '{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}',
    );
  });
});

describe("dumpSessionThreadView", () => {
  it("labels every entry kind deterministically", () => {
    const view: SessionThreadView = {
      threadId: "th",
      entries: [
        ...toolHeavyEntries,
        {
          kind: "model_change",
          provider: "anthropic",
          modelId: "claude-fable-5",
          sourceMessages: [],
        },
        { kind: "thinking_level_change", level: "high", sourceMessages: [] },
      ],
    };
    const dump = dumpSessionThreadView(view);
    expect(dump).toContain("[user]\nplease list files");
    expect(dump).toContain("[assistant thinking]\nneed ls");
    expect(dump).toContain(
      '[tool call · Bash · toolu_01AB]\n{"command":"ls","description":"List"}',
    );
    expect(dump).toContain("[tool result · toolu_01AB]\na.ts\nb.ts");
    expect(dump).toContain("[tool result · toolu_02 · error]\nboom");
    expect(dump).toContain("[model change · anthropic/claude-fable-5]");
    expect(dump).toContain("[thinking level change · high]");
  });
});

describe("dumpClaudeRolloutLines", () => {
  it("skips harness bookkeeping exactly as intake does", () => {
    const items = parseRolloutContent<Record<string, unknown>>(
      [
        '{"type":"mode","mode":"normal"}',
        '{"type":"user","isSidechain":true,"message":{"role":"user","content":"sidechain"}}',
        '{"type":"user","isMeta":true,"message":{"role":"user","content":"meta"}}',
        '{"type":"user","message":{"role":"user","content":"<command-name>/exit</command-name>"}}',
        '{"type":"user","message":{"role":"user","content":"<local-command-stdout>See ya!</local-command-stdout>"}}',
        '{"type":"assistant","message":{"role":"assistant","model":"<synthetic>","content":[{"type":"text","text":"No response requested."}]}}',
        '{"type":"user","message":{"role":"user","content":"real prompt"}}',
        '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"body"}],"is_error":false}]}}',
        "not json",
      ].join("\n"),
    );
    const dump = dumpClaudeRolloutLines(items);
    expect(dump).not.toContain("sidechain");
    expect(dump).not.toContain("meta");
    expect(dump).not.toContain("command-name");
    expect(dump).not.toContain("See ya!");
    expect(dump).not.toContain("No response requested.");
    expect(dump).toContain("[user]\nreal prompt");
    // non-string tool_result content normalizes through plain stringification
    expect(dump).toContain(
      `[tool result · t1]\n${JSON.stringify([{ type: "text", text: "body" }])}`,
    );
  });
});

describe("rebuild faithfulness invariants", () => {
  // The certification core, one per lane: the canonical dump of a rebuilt
  // rollout equals the dump of the thread view it was built from. Any lossy
  // rendering (bracket labels, dropped ids, flattened blocks) breaks it.
  const view: SessionThreadView = { threadId: "th", entries: toolHeavyEntries };

  it("claude: a rebuilt rollout dumps identically to its source view", () => {
    const rebuilt = buildClaudeRolloutLines({
      entries: view.entries,
      newSessionId: "sid",
      envelope: { cwd: "/w", assistantModel: "claude-opus-4-6" },
    });
    expect(dumpClaudeRolloutLines(rebuilt.map((entry) => entry.line))).toBe(
      dumpSessionThreadView(view),
    );
  });

  it("codex: a rebuilt rollout dumps identically to its source view", () => {
    const rebuilt = buildCodexRolloutLines({
      entries: view.entries,
      newSessionId: "11111111-2222-4333-8444-555555555555",
      cwd: "/w",
      clock: () => new Date("2026-07-19T12:00:00.000Z"),
    });
    expect(dumpCodexRolloutLines(rebuilt.map((entry) => entry.line))).toBe(
      dumpSessionThreadView(view),
    );
  });
});
