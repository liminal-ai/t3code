/** Codex rollout JSONL envelope shapes (app-server thread store). */

export interface CodexRolloutLine {
  timestamp: string;
  type: "session_meta" | "response_item" | "event_msg";
  payload: Record<string, unknown>;
  [key: string]: unknown;
}

/** Envelope line shape consumed by codex rollout intake mappers. */
export interface RolloutLineItem {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}
