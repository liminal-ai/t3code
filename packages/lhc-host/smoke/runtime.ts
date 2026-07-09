// @effect-diagnostics globalTimers:off
/**
 * Provider runtime reads distilled from probes/phase4-acceptance.ts.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

export function readProviderRuntime(
  baseDir: string,
  threadId: string,
): { resumeCursor: unknown; runtimePayload: unknown } | null {
  const dbPath = NodePath.join(baseDir, "userdata", "state.sqlite");
  if (!NodeFS.existsSync(dbPath)) return null;
  const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT resume_cursor_json, runtime_payload_json FROM provider_session_runtime WHERE thread_id = ?",
      )
      .get(threadId) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const parse = (v: unknown) => {
      if (typeof v !== "string") return v ?? null;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    };
    return {
      resumeCursor: parse(row.resume_cursor_json),
      runtimePayload: parse(row.runtime_payload_json),
    };
  } finally {
    db.close();
  }
}
