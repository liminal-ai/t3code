// @effect-diagnostics globalTimers:off globalDate:off
import { describe, expect, it } from "vite-plus/test";

import {
  assistantAnswerFromItems,
  estimateCostUsd,
  formatFailuresStderr,
  formatReportMarkdown,
  formatReportTableStdout,
  formatReportTimestamp,
  judgeCaptureCheck,
  judgeDerivationStatus,
  judgeResumeResult,
  judgeSwapResult,
  sessionIdFromCursor,
  verifyServerIdentity,
  type SmokeStepResult,
} from "./lib.ts";

describe("pickFreePort / identity / report (sync-smoke lib)", () => {
  it("verifyServerIdentity accepts matching pid and fresh startedAt", () => {
    const spawn = Date.parse("2026-07-09T18:00:00.000Z");
    const result = verifyServerIdentity({
      runtime: {
        pid: 4242,
        startedAt: "2026-07-09T18:00:01.000Z",
        port: 51234,
        origin: "http://127.0.0.1:51234",
      },
      expectedPid: 4242,
      spawnTimeMs: spawn,
    });
    expect(result.ok).toBe(true);
  });

  it("verifyServerIdentity rejects pid mismatch (stale server masquerade)", () => {
    const result = verifyServerIdentity({
      runtime: {
        pid: 9999,
        startedAt: "2026-07-09T18:00:01.000Z",
        port: 4601,
        origin: "http://127.0.0.1:4601",
      },
      expectedPid: 4242,
      spawnTimeMs: Date.parse("2026-07-09T18:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("pid mismatch");
  });

  it("verifyServerIdentity rejects startedAt before spawn", () => {
    const result = verifyServerIdentity({
      runtime: {
        pid: 4242,
        startedAt: "2026-07-08T10:00:00.000Z",
        port: 4601,
        origin: "http://127.0.0.1:4601",
      },
      expectedPid: 4242,
      spawnTimeMs: Date.parse("2026-07-09T18:00:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("stale server");
  });

  it("sessionIdFromCursor reads claude resume and codex threadId", () => {
    expect(sessionIdFromCursor({ resume: "abc" }, "claude")).toBe("abc");
    expect(sessionIdFromCursor({ threadId: "xyz" }, "codex")).toBe("xyz");
  });

  it("judgeCaptureCheck accepts the canonical one-open-turn shape", () => {
    const pass = judgeCaptureCheck({
      lineageFound: true,
      userPromptCount: 3,
      turnsSent: 3,
      duplicatedPromptCount: 0,
      maxToolResultBytes: 12_000,
      turnsClosed: 3,
      turnsOpen: 1,
    });
    expect(pass.pass).toBe(true);

    const fail = judgeCaptureCheck({
      lineageFound: true,
      userPromptCount: 4,
      turnsSent: 3,
      duplicatedPromptCount: 1,
      maxToolResultBytes: 500,
      turnsClosed: 2,
      turnsOpen: 2,
    });
    expect(fail.pass).toBe(false);
    expect(fail.reasons.length).toBeGreaterThan(0);
  });

  it("assistantAnswerFromItems preserves streamed text across an empty completion", () => {
    const items = [
      {
        kind: "snapshot",
        snapshot: {
          thread: {
            messages: [
              {
                id: "old-message",
                role: "assistant",
                text: "old answer",
                turnId: "old-turn",
                streaming: false,
              },
            ],
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "thread.message-sent",
          payload: {
            messageId: "new-message",
            role: "assistant",
            text: "codename=",
            turnId: "new-turn",
            streaming: true,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "thread.message-sent",
          payload: {
            messageId: "new-message",
            role: "assistant",
            text: "COPPER-IBIS-42",
            turnId: "new-turn",
            streaming: true,
          },
        },
      },
      {
        kind: "event",
        event: {
          type: "thread.message-sent",
          payload: {
            messageId: "new-message",
            role: "assistant",
            text: "",
            turnId: "new-turn",
            streaming: false,
          },
        },
      },
    ];

    expect(assistantAnswerFromItems(items, "new-turn")).toBe("codename=COPPER-IBIS-42");
    expect(assistantAnswerFromItems(items, "old-turn")).toBe("old answer");
  });

  it("judgeSwapResult and judgeResumeResult", () => {
    expect(
      judgeSwapResult({
        httpStatus: 200,
        newSessionId: "new-id",
        cursorSessionId: "new-id",
        rebuiltExists: true,
      }).pass,
    ).toBe(true);

    expect(
      judgeResumeResult({
        answer: "codename=COPPER-IBIS-42 lucky=7391",
        codename: "COPPER-IBIS-42",
        cursorSessionId: "new-id",
        expectedSessionId: "new-id",
      }).pass,
    ).toBe(true);
  });

  it("judgeDerivationStatus rejects failed/blocked", () => {
    expect(judgeDerivationStatus({ failed: 0, blocked: 0 }).pass).toBe(true);
    expect(judgeDerivationStatus({ failed: 1, blocked: 0 }).pass).toBe(false);
  });

  it("formatReportTimestamp pads month/day/hour/minute", () => {
    const ts = formatReportTimestamp(new Date("2026-07-09T08:05:00"));
    expect(ts).toMatch(/^2026-07-09-\d{4}$/);
    expect(ts.endsWith("0805") || ts.endsWith("0405") || ts.endsWith("1205")).toBe(true);
  });

  it("formatReportMarkdown and stdout table include PASS/FAIL rows", () => {
    const steps: SmokeStepResult[] = [
      { id: "boot", label: "boot", status: "PASS", durationMs: 1200 },
      {
        id: "claude:capture",
        label: "claude capture",
        provider: "claude",
        status: "FAIL",
        durationMs: 800,
        detail: "no lineage",
        evidence: "HTTP 404",
      },
    ];
    const input = {
      generatedAt: new Date("2026-07-09T18:50:00Z"),
      overallPass: false,
      totalDurationMs: 2000,
      steps,
      claudeTurns: 4,
      codexTurns: 4,
      port: 51234,
      baseDir: "/tmp/base",
      lhcHome: "/tmp/lhc",
      skipClaude: false,
      skipCodex: false,
    };
    const md = formatReportMarkdown(input);
    expect(md).toContain("# LHC sync smoke report");
    expect(md).toContain("| claude capture | claude | FAIL");
    expect(md).toContain("## Failure evidence");
    expect(formatReportTableStdout(input)).toContain("SYNC SMOKE: FAIL");
    expect(estimateCostUsd({ claudeTurns: 4, codexTurns: 4 })).toBeCloseTo(0.012);
    const err = formatFailuresStderr(steps);
    expect(err).toContain("[claude capture]");
    expect(err).toContain("HTTP 404");
  });
});

describe("pickFreePort", () => {
  it("returns a positive ephemeral port on loopback", async () => {
    const { pickFreePort } = await import("./lib.ts");
    const port = await pickFreePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});
