import { createDeterministicInferenceCallbacks, type SdkConfig } from "lhc";

import { ccAssignments } from "./inference/assignments.ts";
import { claudeCliModelCall } from "./inference/claude-cli.ts";

const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;

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

export function captureSdkConfig(options: { noInference?: boolean } = {}): SdkConfig {
  if (options.noInference === true || isInferenceDisabled()) {
    return {
      mode: "manual",
      inferenceCallbacks: createDeterministicInferenceCallbacks(),
    };
  }
  return {
    mode: "background",
    inference: {
      call: claudeCliModelCall,
      assignments: ccAssignments(),
      timeoutMs: DEFAULT_INFERENCE_TIMEOUT_MS,
    },
  };
}
