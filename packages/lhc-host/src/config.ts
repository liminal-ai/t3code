import { createDeterministicInferenceCallbacks, type SdkConfig } from "lhc";

import { isInferenceDisabled } from "./flags.ts";
import { ccAssignments } from "./inference/assignments.ts";
import { claudeCliModelCall } from "./inference/claude-cli.ts";

export {
  isAutoCompactSuppressionEnabled,
  isCaptureDisabled,
  isInferenceDisabled,
} from "./flags.ts";

const DEFAULT_INFERENCE_TIMEOUT_MS = 60_000;

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
