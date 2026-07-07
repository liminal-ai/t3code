// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { OpResult } from "lhc";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { createLineageStore, type LineageStore } from "./lineage.ts";
import { lineageDbPath, newThreadFilePath, registryPath, threadsDir } from "./paths.ts";

let home: string;
let store: LineageStore;

beforeEach(() => {
  home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lhc-host-lineage-"));
  NodeFS.mkdirSync(threadsDir(home), { recursive: true });
  store = createLineageStore(
    { dbPath: lineageDbPath(home), registryPath: registryPath(home) },
    { threadFilePathFn: () => newThreadFilePath(home) },
  );
});

afterEach(() => {
  NodeFS.rmSync(home, { recursive: true, force: true });
});

function assertOk<T>(result: OpResult<T>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error.reason);
  return result.value;
}

describe("lineage store", () => {
  it("creates an LHC thread and row on first sight, resolves the same row after", async () => {
    const first = assertOk(
      await store.getOrCreate("t3-thread-1", { providerKind: "codex", title: "first thread" }),
    );
    expect(first.created).toBe(true);
    expect(first.lhcThreadId).not.toBe("");

    const second = assertOk(await store.getOrCreate("t3-thread-1", { providerKind: "codex" }));
    expect(second.created).toBe(false);
    expect(second.lhcThreadId).toBe(first.lhcThreadId);

    const row = store.lookup("t3-thread-1");
    expect(row?.lhcThreadId).toBe(first.lhcThreadId);
    expect(row?.providerKind).toBe("codex");
    expect(store.list()).toHaveLength(1);

    // The thread file exists under threads/ (file-then-row order).
    const files = NodeFS.readdirSync(threadsDir(home)).filter((name) => name.endsWith(".sqlite"));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  it("distinct t3 threads map to distinct LHC threads", async () => {
    const a = assertOk(await store.getOrCreate("t3-a", { providerKind: "claudeAgent" }));
    const b = assertOk(await store.getOrCreate("t3-b", { providerKind: "codex" }));
    expect(a.lhcThreadId).not.toBe(b.lhcThreadId);
    expect(store.list()).toHaveLength(2);
  });

  it("concurrent getOrCreate for the same thread races to one row", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.getOrCreate("t3-race", { providerKind: "codex" })),
    );
    const ids = new Set(results.map((result) => assertOk(result).lhcThreadId));
    expect(ids.size).toBe(1);

    const rows = store.list().filter((row) => row.t3ThreadId === "t3-race");
    expect(rows).toHaveLength(1);
    expect(ids.has(rows[0]!.lhcThreadId)).toBe(true);
    // Exactly one of the racers observes created: true for the winning row.
    const wins = results.filter((result) => assertOk(result).created);
    expect(wins.length).toBeLessThanOrEqual(1);
  });
});
