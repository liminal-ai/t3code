// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { threads, type OpResult } from "lhc";

import { newThreadFilePath } from "./paths.ts";

export interface LineageMeta {
  providerKind: string;
  title?: string;
  cwd?: string;
}

export interface LineageRow {
  t3ThreadId: string;
  lhcThreadId: string;
  providerKind: string;
  createdAt: string;
}

export interface LineageResolution {
  lhcThreadId: string;
  /** false when the t3 thread already had a row (or lost a creation race). */
  created: boolean;
}

export interface LineageStoreDeps {
  nowFn?: () => Date;
  newThreadFn?: typeof threads.newThread;
  threadFilePathFn?: () => string;
  openDbFn?: (path: string) => NodeSqlite.DatabaseSync;
}

export interface LineageStore {
  getOrCreate(t3ThreadId: string, meta: LineageMeta): Promise<OpResult<LineageResolution>>;
  lookup(t3ThreadId: string): LineageRow | undefined;
  list(): LineageRow[];
}

function initLineageSchema(db: NodeSqlite.DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS t3_thread_lineage (
      t3_thread_id TEXT PRIMARY KEY,
      lhc_thread_id TEXT NOT NULL,
      provider_kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

function toRow(raw: {
  t3_thread_id: string;
  lhc_thread_id: string;
  provider_kind: string;
  created_at: string;
}): LineageRow {
  return {
    t3ThreadId: raw.t3_thread_id,
    lhcThreadId: raw.lhc_thread_id,
    providerKind: raw.provider_kind,
    createdAt: raw.created_at,
  };
}

function storageFailure(reason: string): { ok: false; error: OpResultError } {
  return { ok: false, error: { errorClass: "system_error", code: "storage_failure", reason } };
}

type OpResultError = Extract<OpResult<never>, { ok: false }>["error"];

function detail(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Lineage database mapping t3 `ThreadId` → LHC thread id in
 * `~/.t3code-lhc/t3code-lhc.sqlite` (cc-lhc lineage-db pattern: open/close per
 * operation, WAL, LHC-thread-then-lineage-row creation order). A crash or lost
 * race between creating the LHC thread and recording the lineage row leaves an
 * orphan LHC thread — its thread file AND its registry row, both written by
 * `newThread` — with no lineage row pointing at it. That residue is harmless.
 */
export function createLineageStore(
  paths: { dbPath: string; registryPath: string },
  deps: LineageStoreDeps = {},
): LineageStore {
  const nowFn = deps.nowFn ?? (() => new Date());
  const newThreadFn = deps.newThreadFn ?? threads.newThread;
  const threadFilePathFn = deps.threadFilePathFn ?? (() => newThreadFilePath());
  const openDbFn = deps.openDbFn ?? ((path: string) => new NodeSqlite.DatabaseSync(path));

  function withDb<T>(run: (db: NodeSqlite.DatabaseSync) => T): T {
    NodeFS.mkdirSync(NodePath.dirname(paths.dbPath), { recursive: true });
    const db = openDbFn(paths.dbPath);
    try {
      initLineageSchema(db);
      return run(db);
    } finally {
      db.close();
    }
  }

  function selectRow(db: NodeSqlite.DatabaseSync, t3ThreadId: string): LineageRow | undefined {
    const raw = db
      .prepare(
        "SELECT t3_thread_id, lhc_thread_id, provider_kind, created_at FROM t3_thread_lineage WHERE t3_thread_id = ?",
      )
      .get(t3ThreadId) as
      | { t3_thread_id: string; lhc_thread_id: string; provider_kind: string; created_at: string }
      | undefined;
    return raw === undefined ? undefined : toRow(raw);
  }

  return {
    async getOrCreate(t3ThreadId, meta): Promise<OpResult<LineageResolution>> {
      try {
        const existing = withDb((db) => selectRow(db, t3ThreadId));
        if (existing !== undefined) {
          return { ok: true, value: { lhcThreadId: existing.lhcThreadId, created: false } };
        }
      } catch (cause) {
        return storageFailure(`lineage read failed: ${detail(cause)}`);
      }

      // File-then-row: create the LHC thread first, then record the mapping.
      const created = await newThreadFn({
        filePath: threadFilePathFn(),
        registryPath: paths.registryPath,
        ...(meta.title === undefined ? {} : { title: meta.title }),
        ...(meta.cwd === undefined ? {} : { cwd: meta.cwd }),
      });
      if (!created.ok) return created;

      try {
        return withDb((db): OpResult<LineageResolution> => {
          db.prepare(
            "INSERT OR IGNORE INTO t3_thread_lineage (t3_thread_id, lhc_thread_id, provider_kind, created_at) VALUES (?, ?, ?, ?)",
          ).run(t3ThreadId, created.value.threadId, meta.providerKind, nowFn().toISOString());
          const row = selectRow(db, t3ThreadId);
          if (row === undefined) {
            return storageFailure(`lineage row for ${t3ThreadId} missing after insert`);
          }
          // A concurrent getOrCreate may have won the INSERT OR IGNORE; the
          // loser's LHC thread — its thread file AND registry row, both created
          // by newThread above — is a documented-harmless orphan (no lineage
          // row references it).
          return {
            ok: true,
            value: {
              lhcThreadId: row.lhcThreadId,
              created: row.lhcThreadId === created.value.threadId,
            },
          };
        });
      } catch (cause) {
        return storageFailure(`lineage write failed: ${detail(cause)}`);
      }
    },

    lookup(t3ThreadId): LineageRow | undefined {
      return withDb((db) => selectRow(db, t3ThreadId));
    },

    list(): LineageRow[] {
      return withDb((db) => {
        const raws = db
          .prepare(
            "SELECT t3_thread_id, lhc_thread_id, provider_kind, created_at FROM t3_thread_lineage ORDER BY created_at ASC",
          )
          .all() as Array<{
          t3_thread_id: string;
          lhc_thread_id: string;
          provider_kind: string;
          created_at: string;
        }>;
        return raws.map(toRow);
      });
    },
  };
}
