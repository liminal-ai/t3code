// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

const CODEX_HOME_CONTINUATION_PREFIX = "codex:home:";

export function readCodexHomeFromContinuationKey(key: string): string | undefined {
  return key.startsWith(CODEX_HOME_CONTINUATION_PREFIX)
    ? key.slice(CODEX_HOME_CONTINUATION_PREFIX.length)
    : undefined;
}

export function deriveCodexSwapHomePath(continuationKey: string): string {
  const home = readCodexHomeFromContinuationKey(continuationKey);
  if (home === undefined || home.trim() === "") {
    throw new Error("Codex provider instance did not expose a resolved CODEX_HOME.");
  }
  return NodePath.resolve(home);
}
