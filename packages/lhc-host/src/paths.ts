// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

/**
 * State root for the t3code LHC host: `~/.t3code-lhc/` (standing decision —
 * hosts own their state dirs, never `~/.lhc`). Overridable via
 * `T3CODE_LHC_HOME` for tests and alternate deployments.
 */
export function lhcHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.T3CODE_LHC_HOME;
  return override !== undefined && override !== ""
    ? override
    : NodePath.join(NodeOS.homedir(), ".t3code-lhc");
}

/** LHC thread registry database. */
export function registryPath(home: string = lhcHome()): string {
  return NodePath.join(home, "registry.sqlite");
}

/** Host lineage database (t3 ThreadId ↔ LHC thread id). */
export function lineageDbPath(home: string = lhcHome()): string {
  return NodePath.join(home, "t3code-lhc.sqlite");
}

export function threadsDir(home: string = lhcHome()): string {
  return NodePath.join(home, "threads");
}

/** SQLite will not create parent directories; call once at service start. */
export function ensureStateDirs(home: string = lhcHome()): void {
  NodeFS.mkdirSync(threadsDir(home), { recursive: true });
}

export function newThreadFilePath(home: string = lhcHome()): string {
  return NodePath.join(threadsDir(home), `${NodeCrypto.randomUUID()}.sqlite`);
}

export function captureThreadRef(
  threadId: string,
  registry: string,
): { threadId: string; registryPath: string } {
  return { threadId, registryPath: registry };
}
