// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const CLAUDE_HOME_CONTINUATION_PREFIX = "claude:home:";

export function readClaudeHomeFromContinuationKey(key: string): string | undefined {
  return key.startsWith(CLAUDE_HOME_CONTINUATION_PREFIX)
    ? key.slice(CLAUDE_HOME_CONTINUATION_PREFIX.length)
    : undefined;
}

export interface DeriveClaudeSwapHomePathInput {
  continuationKey: string;
  env?: NodeJS.ProcessEnv | { readonly HOME?: string | undefined };
  osHomeDir?: string;
  realpath?: (path: string) => Promise<string>;
}

export async function deriveClaudeSwapHomePath({
  continuationKey,
  env = process.env,
  osHomeDir = NodeOS.homedir(),
  realpath = NodeFSP.realpath,
}: DeriveClaudeSwapHomePathInput): Promise<string> {
  const keyHome = readClaudeHomeFromContinuationKey(continuationKey);
  if (keyHome === undefined || keyHome.trim() === "") {
    throw new Error("Claude provider instance did not expose a resolved HOME.");
  }

  const resolvedKeyHome = NodePath.resolve(keyHome);
  const resolvedDefaultHome = NodePath.resolve(osHomeDir);
  const homeForSdk =
    resolvedKeyHome === resolvedDefaultHome ? NodePath.resolve(env.HOME ?? osHomeDir) : keyHome;
  return realpath(NodePath.resolve(homeForSdk));
}
