// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { SessionThreadView } from "lhc";

import {
  buildRolloutLines,
  formatSwapReceipt,
  parseRolloutEnvelopeFromContent,
  runtimeNoteRolloutLine,
  serializeRolloutLines,
  type RebuildRolloutInput,
  type RolloutEnvelope,
} from "./rebuild.ts";

/** Encode cwd the way Claude Code names project dirs under ~/.claude/projects/. */
export function encodeProjectPath(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, "-");
}

export function claudeProjectsDirFromHome(claudeHomePath: string): string {
  return NodePath.join(claudeHomePath, ".claude", "projects");
}

export interface RolloutWriteDeps {
  mkdirFn?: typeof NodeFSP.mkdir;
  openFn?: typeof NodeFSP.open;
  readFileFn?: typeof NodeFSP.readFile;
  realpathFn?: typeof NodeFSP.realpath;
}

const defaultDeps = (): Required<RolloutWriteDeps> => ({
  mkdirFn: NodeFSP.mkdir,
  openFn: NodeFSP.open,
  readFileFn: NodeFSP.readFile,
  realpathFn: NodeFSP.realpath,
});

export async function writeRolloutFileFsync(
  filePath: string,
  content: string,
  deps: RolloutWriteDeps = {},
): Promise<void> {
  const { mkdirFn, openFn } = { ...defaultDeps(), ...deps };
  await mkdirFn(NodePath.dirname(filePath), { recursive: true });
  const handle = await openFn(filePath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function rolloutPathForSession(
  claudeProjectsDir: string,
  cwd: string,
  sessionId: string,
): string {
  return NodePath.join(claudeProjectsDir, encodeProjectPath(cwd), `${sessionId}.jsonl`);
}

async function resolveCwdRealpath(cwd: string, deps: RolloutWriteDeps): Promise<string> {
  const { realpathFn } = { ...defaultDeps(), ...deps };
  try {
    return await realpathFn(cwd);
  } catch {
    return cwd;
  }
}

export interface WriteRebuiltRolloutInput {
  view: SessionThreadView;
  cwd: string;
  /** Absolute path to `<claudeHome>/.claude/projects` for the provider instance. */
  claudeProjectsDir: string;
  sourceRolloutPath?: string;
  newSessionId?: string;
  deps?: RolloutWriteDeps;
  readSourceFn?: (path: string) => Promise<string>;
  /** When set, append the swap receipt as a trailing runtime-note line. */
  swapReceipt?: { oldSessionId: string };
}

export interface WriteRebuiltRolloutResult {
  sessionId: string;
  rolloutPath: string;
  lineCount: number;
  expectedReintakeLines: number;
  /**
   * Lines the handoff capture must hard-skip as replayed served-view content.
   * A trailing swap receipt is NOT among them: it is genuinely new history
   * that must map into the thread record (as runtime_note) so later rebuilds
   * re-serve it.
   */
  replayedPrefixLines: number;
}

export async function writeRebuiltRollout(
  input: WriteRebuiltRolloutInput,
): Promise<WriteRebuiltRolloutResult> {
  const deps = input.deps ?? {};
  const resolvedCwd = await resolveCwdRealpath(input.cwd, deps);
  const newSessionId = input.newSessionId ?? NodeCrypto.randomUUID();
  const readSource =
    input.readSourceFn ??
    ((path: string) => {
      const { readFileFn } = { ...defaultDeps(), ...deps };
      return readFileFn(path, "utf8");
    });

  let envelope: RolloutEnvelope = { cwd: resolvedCwd, version: "2.1.201" };
  if (input.sourceRolloutPath !== undefined) {
    const sourceContent = await readSource(input.sourceRolloutPath);
    envelope = parseRolloutEnvelopeFromContent(sourceContent, resolvedCwd);
  }

  const rebuildInput: RebuildRolloutInput = {
    entries: input.view.entries,
    newSessionId,
    envelope,
  };
  const lines = buildRolloutLines(rebuildInput);
  const replayedPrefixLines = lines.length;
  if (input.swapReceipt !== undefined) {
    // The receipt line itself replays on re-intake, so the count includes it.
    const receipt = formatSwapReceipt(
      input.swapReceipt.oldSessionId,
      newSessionId,
      lines.length + 1,
    );
    const lastUuid = lines.length > 0 ? lines[lines.length - 1]!.line.uuid : null;
    lines.push(
      runtimeNoteRolloutLine(
        receipt,
        newSessionId,
        envelope,
        typeof lastUuid === "string" ? lastUuid : null,
      ),
    );
  }
  const serialized = serializeRolloutLines(lines);
  const rolloutPath = rolloutPathForSession(input.claudeProjectsDir, resolvedCwd, newSessionId);

  await writeRolloutFileFsync(rolloutPath, serialized, deps);

  return {
    sessionId: newSessionId,
    rolloutPath,
    lineCount: lines.length,
    expectedReintakeLines: lines.length,
    replayedPrefixLines,
  };
}
