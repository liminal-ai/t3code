/**
 * Side-effect-free LHC env-flag readers. Keep this module free of inference or
 * capture imports so consumers (e.g. ClaudeAdapter) can read flags without
 * pulling the inference lane.
 */

/**
 * Belt-and-braces kill switch: `T3CODE_LHC_DISABLE=1` makes the whole capture
 * service a no-op (no SDK instance, no state dirs, no event handling).
 */
export function isCaptureDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.T3CODE_LHC_DISABLE === "1";
}

/**
 * `T3CODE_LHC_NO_INFERENCE=1`: capture still records everything, but the SDK
 * runs in manual mode with deterministic callbacks — no model calls, and
 * shutdown skips drain-settle waits (cc-lhc pattern).
 */
export function isInferenceDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.T3CODE_LHC_NO_INFERENCE === "1";
}

/**
 * `T3CODE_LHC_SUPPRESS_AUTOCOMPACT`: when LHC capture is active, disable Claude
 * Code's native auto-compact per session (via SDK flag settings) so LHC compaction
 * does not race it. Defaults to on; set `0`/`false` to opt out. Forced off when
 * `T3CODE_LHC_DISABLE=1`.
 */
export function isAutoCompactSuppressionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (isCaptureDisabled(env)) {
    return false;
  }
  const raw = env.T3CODE_LHC_SUPPRESS_AUTOCOMPACT;
  if (raw === "0" || raw === "false") {
    return false;
  }
  return true;
}
