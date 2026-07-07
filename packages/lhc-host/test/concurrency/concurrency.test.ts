import { describe, expect, it } from "vite-plus/test";

import { runConcurrencyScenario } from "./load-harness.js";

describe("lhc background drain multi-thread concurrency", () => {
  it("drains concurrent intake across many threads without cross-thread contamination", async () => {
    const summary = await runConcurrencyScenario({
      name: "default-no-failure",
      failureRate: 0,
      realInference: false,
    });

    expect(summary.totalEventsSent).toBe(
      summary.options.threadCount * summary.options.turnsPerThread * 6,
    );
    expect(summary.aggregateHealth.failed).toBe(0);
    expect(summary.aggregateHealth.blocked).toBe(0);
    expect(summary.aggregateHealth.pending).toBe(0);
    expect(summary.aggregateHealth.retrying).toBe(0);
    expect(summary.aggregateHealth.queueQueued).toBe(0);
    expect(summary.aggregateHealth.queueClaimed).toBe(0);
    expect(summary.threads).toHaveLength(summary.options.threadCount);
    expect(
      summary.threads.every((thread) => thread.messageCount === summary.options.turnsPerThread * 5),
    ).toBe(true);
    expect(summary.inferenceMaxConcurrent).toBeGreaterThan(1);
  }, 60_000);

  it("retryable inference failures back off and do not wedge other thread drains", async () => {
    const summary = await runConcurrencyScenario({
      name: "retryable-failures",
      failureRate: 0.2,
      realInference: false,
      retry: { budget: 5, backoffBaseMs: 25, backoffCapMs: 100 },
    });

    expect(summary.inferenceFailuresInjected).toBeGreaterThan(0);
    expect(summary.aggregateHealth.failed).toBe(0);
    expect(summary.aggregateHealth.blocked).toBe(0);
    expect(summary.aggregateHealth.pending).toBe(0);
    expect(summary.aggregateHealth.retrying).toBe(0);
    expect(summary.aggregateHealth.queueQueued).toBe(0);
    expect(summary.aggregateHealth.queueClaimed).toBe(0);
    expect(summary.threads.every((thread) => thread.health.ready > 0)).toBe(true);
  }, 60_000);

  it.skipIf(process.env.LHC_LOAD_REAL_INFERENCE !== "1")(
    "optionally smokes a tiny real claude -p callback run",
    async () => {
      const summary = await runConcurrencyScenario({
        name: "real-claude-smoke",
        threadCount: 2,
        turnsPerThread: 1,
        failureRate: 0,
        realInference: true,
        retry: { budget: 2, backoffBaseMs: 100, backoffCapMs: 1000 },
      });

      expect(summary.aggregateHealth.failed).toBe(0);
      expect(summary.aggregateHealth.blocked).toBe(0);
      expect(summary.aggregateHealth.queueQueued).toBe(0);
      expect(summary.aggregateHealth.queueClaimed).toBe(0);
    },
    600_000,
  );
});
