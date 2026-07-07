import { describe, expect, it } from "vite-plus/test";

import { initLhc } from "lhc";

import { ccAssignments, INFERENCE_ASSIGNMENT_KINDS } from "./assignments.js";
import { createClaudeCliModelCall } from "./claude-cli.js";

describe("ccAssignments", () => {
  it("constructs initLhc with cc-cli inference config", () => {
    const assignments = ccAssignments();
    expect(Object.keys(assignments).sort()).toEqual([...INFERENCE_ASSIGNMENT_KINDS].sort());
    for (const kind of INFERENCE_ASSIGNMENT_KINDS) {
      expect(assignments[kind].provider).toBe("cc-cli");
      expect(assignments[kind].model).toBeTruthy();
      expect(assignments[kind].prompt).toBeTruthy();
    }
    expect(() =>
      initLhc({
        mode: "background",
        inference: {
          call: createClaudeCliModelCall({ binary: () => "/bin/false" }),
          assignments,
          timeoutMs: 60_000,
        },
      }),
    ).not.toThrow();
  });
});
