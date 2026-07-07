export function resolveClaudeBin(): string {
  return process.env.T3CODE_LHC_CLAUDE_BIN ?? "claude";
}
