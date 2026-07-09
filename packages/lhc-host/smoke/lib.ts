// @effect-diagnostics globalTimers:off globalDate:off
/**
 * Pure helpers for sync-smoke: port picking, server identity checks, report
 * formatting, and judgement logic (unit-tested without live providers).
 */
import * as NodeNet from "node:net";

// ---------------------------------------------------------------------------
// Port picking
// ---------------------------------------------------------------------------

/** Bind to port 0 on loopback and return the assigned ephemeral port. */
export function pickFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("pickFreePort: no numeric address")));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ---------------------------------------------------------------------------
// Server identity (stale-server masquerade guard)
// ---------------------------------------------------------------------------

export interface ServerRuntimeSnapshot {
  readonly pid: number;
  readonly startedAt: string;
  readonly port: number;
  readonly origin: string;
}

export type IdentityCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export function verifyServerIdentity(input: {
  readonly runtime: ServerRuntimeSnapshot;
  readonly expectedPid: number;
  readonly spawnTimeMs: number;
  /** Allow clock skew between spawn and server DateTime.now (default 2s). */
  readonly clockSkewMs?: number;
}): IdentityCheckResult {
  if (input.runtime.pid !== input.expectedPid) {
    return {
      ok: false,
      reason: `pid mismatch: runtime.json pid=${String(input.runtime.pid)} expected child pid=${String(input.expectedPid)}`,
    };
  }
  const startedMs = Date.parse(input.runtime.startedAt);
  if (Number.isNaN(startedMs)) {
    return {
      ok: false,
      reason: `invalid startedAt in runtime.json: ${input.runtime.startedAt}`,
    };
  }
  const skew = input.clockSkewMs ?? 2_000;
  if (startedMs < input.spawnTimeMs - skew) {
    return {
      ok: false,
      reason:
        `stale server: runtime.json startedAt=${input.runtime.startedAt} is before ` +
        `our spawn (${new Date(input.spawnTimeMs).toISOString()})`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Resume cursor helpers
// ---------------------------------------------------------------------------

export type SmokeProvider = "claude" | "codex";

export function sessionIdFromCursor(cursor: unknown, provider: SmokeProvider): string | undefined {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const record = cursor as Record<string, unknown>;
  if (provider === "claude") {
    return typeof record.resume === "string" ? record.resume : undefined;
  }
  return typeof record.threadId === "string" ? record.threadId : undefined;
}

// ---------------------------------------------------------------------------
// Thread event helpers
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

interface AssistantMessageState {
  readonly messageId: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly order: number;
}

/**
 * Reconstruct the latest assistant message using the same streaming semantics
 * as the client thread reducer. Provider completion events commonly carry an
 * empty final text, which must not erase the accumulated deltas.
 */
export function assistantAnswerFromItems(
  items: ReadonlyArray<unknown>,
  turnId: string | null,
): string | null {
  const messages = new Map<string, AssistantMessageState>();
  let order = 0;

  const applyMessage = (value: unknown): void => {
    if (!isRecord(value) || value.role !== "assistant" || typeof value.text !== "string") return;
    const messageId =
      typeof value.messageId === "string"
        ? value.messageId
        : typeof value.id === "string"
          ? value.id
          : undefined;
    if (!messageId) return;

    const nextTurnId = typeof value.turnId === "string" ? value.turnId : null;
    const existing = messages.get(messageId);
    const streaming = value.streaming === true;
    const text = existing
      ? streaming
        ? `${existing.text}${value.text}`
        : value.text.length > 0
          ? value.text
          : existing.text
      : value.text;

    messages.set(messageId, {
      messageId,
      text,
      turnId: nextTurnId ?? existing?.turnId ?? null,
      order: order++,
    });
  };

  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.kind === "snapshot" && isRecord(item.snapshot)) {
      const thread = item.snapshot.thread;
      if (isRecord(thread) && Array.isArray(thread.messages)) {
        for (const message of thread.messages) applyMessage(message);
      }
      continue;
    }
    if (item.kind !== "event" || !isRecord(item.event)) continue;
    if (item.event.type !== "thread.message-sent" || !isRecord(item.event.payload)) continue;
    applyMessage(item.event.payload);
  }

  const matches = [...messages.values()]
    .filter((message) => turnId === null || message.turnId === turnId)
    .sort((a, b) => a.order - b.order);
  return matches.at(-1)?.text ?? null;
}

// ---------------------------------------------------------------------------
// Capture / swap / resume judgement
// ---------------------------------------------------------------------------

export function judgeCaptureCheck(input: {
  readonly lineageFound: boolean;
  readonly userPromptCount: number;
  readonly turnsSent: number;
  readonly duplicatedPromptCount: number;
  readonly maxToolResultBytes: number;
  readonly turnsClosed: number;
  readonly turnsOpen: number;
  readonly minToolBytes?: number;
}): { readonly pass: boolean; readonly reasons: ReadonlyArray<string> } {
  const reasons: string[] = [];
  const minTool = input.minToolBytes ?? 8_000;

  if (!input.lineageFound) reasons.push("no lineage row");
  if (input.userPromptCount !== input.turnsSent) {
    reasons.push(
      `user_prompt count ${String(input.userPromptCount)} !== turns sent ${String(input.turnsSent)}`,
    );
  }
  if (input.duplicatedPromptCount > 0) {
    reasons.push(`duplicate user_prompts: ${String(input.duplicatedPromptCount)}`);
  }
  if (input.maxToolResultBytes < minTool) {
    reasons.push(
      `max tool_result bytes ${String(input.maxToolResultBytes)} < ${String(minTool)} (preview truncation?)`,
    );
  }
  if (input.turnsOpen > 1) {
    reasons.push(`open turns ${String(input.turnsOpen)} > canonical maximum 1`);
  }
  if (input.turnsClosed < input.turnsSent) {
    reasons.push(
      `closed turns ${String(input.turnsClosed)} < turns sent ${String(input.turnsSent)}`,
    );
  }

  return { pass: reasons.length === 0, reasons };
}

export function judgeSwapResult(input: {
  readonly httpStatus: number;
  readonly newSessionId: string | undefined;
  readonly cursorSessionId: string | undefined;
  readonly rebuiltExists: boolean;
}): { readonly pass: boolean; readonly reasons: ReadonlyArray<string> } {
  const reasons: string[] = [];
  if (input.httpStatus !== 200) reasons.push(`HTTP ${String(input.httpStatus)}`);
  if (!input.newSessionId) reasons.push("receipt missing newSessionId");
  if (!input.cursorSessionId) reasons.push("cursor missing session id after swap");
  if (input.newSessionId && input.cursorSessionId && input.newSessionId !== input.cursorSessionId) {
    reasons.push(`cursor ${input.cursorSessionId} !== receipt newSessionId ${input.newSessionId}`);
  }
  if (!input.rebuiltExists) reasons.push("rebuiltPath file missing");
  return { pass: reasons.length === 0, reasons };
}

export function judgeResumeResult(input: {
  readonly answer: string | null;
  readonly codename: string;
  readonly cursorSessionId: string | undefined;
  readonly expectedSessionId: string | undefined;
}): { readonly pass: boolean; readonly reasons: ReadonlyArray<string> } {
  const reasons: string[] = [];
  const text = input.answer ?? "";
  if (!text.includes(input.codename)) {
    reasons.push(
      `answer missing codename ${input.codename}: ${JSON.stringify(text.slice(0, 120))}`,
    );
  }
  if (!input.expectedSessionId) {
    reasons.push("no expected rebuilt session id");
  } else if (input.cursorSessionId !== input.expectedSessionId) {
    reasons.push(
      `resume cursor ${String(input.cursorSessionId)} !== rebuilt id ${input.expectedSessionId}`,
    );
  }
  return { pass: reasons.length === 0, reasons };
}

export function judgeDerivationStatus(input: {
  readonly failed: number;
  readonly blocked: number;
}): { readonly pass: boolean; readonly reasons: ReadonlyArray<string> } {
  const reasons: string[] = [];
  if (input.failed > 0) reasons.push(`derivation.failed=${String(input.failed)}`);
  if (input.blocked > 0) reasons.push(`derivation.blocked=${String(input.blocked)}`);
  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Report formatting
// ---------------------------------------------------------------------------

export type StepStatus = "PASS" | "FAIL" | "SKIP";

export interface SmokeStepResult {
  readonly id: string;
  readonly label: string;
  readonly provider?: SmokeProvider;
  readonly status: StepStatus;
  readonly durationMs: number;
  readonly detail?: string;
  readonly evidence?: string;
}

export interface SmokeReportInput {
  readonly generatedAt: Date;
  readonly overallPass: boolean;
  readonly totalDurationMs: number;
  readonly steps: ReadonlyArray<SmokeStepResult>;
  readonly claudeTurns: number;
  readonly codexTurns: number;
  readonly port: number;
  readonly baseDir: string;
  readonly lhcHome: string;
  readonly skipClaude: boolean;
  readonly skipCodex: boolean;
}

export function estimateCostUsd(input: {
  readonly claudeTurns: number;
  readonly codexTurns: number;
}): number {
  // Honest rough order-of-magnitude for orchestrator budgeting (not billing).
  const CLAUDE_HAIKU_PER_TURN = 0.001;
  const CODEX_MINI_LOW_PER_TURN = 0.002;
  return input.claudeTurns * CLAUDE_HAIKU_PER_TURN + input.codexTurns * CODEX_MINI_LOW_PER_TURN;
}

export function formatReportTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}`
  );
}

export function formatReportMarkdown(input: SmokeReportInput): string {
  const cost = estimateCostUsd({
    claudeTurns: input.claudeTurns,
    codexTurns: input.codexTurns,
  });
  const totalTurns = input.claudeTurns + input.codexTurns;
  const lines: string[] = [
    "# LHC sync smoke report",
    "",
    `**Generated:** ${input.generatedAt.toISOString()}`,
    `**Overall:** ${input.overallPass ? "PASS" : "FAIL"}`,
    `**Duration:** ${(input.totalDurationMs / 1000).toFixed(1)}s`,
    `**Port:** ${String(input.port)}`,
    `**Base dir:** \`${input.baseDir}\``,
    `**LHC home:** \`${input.lhcHome}\``,
    `**Paid turns:** ${String(totalTurns)} (budget ≤8)`,
    `**Estimated cost:** ~$${cost.toFixed(3)} (haiku + gpt-5.4-mini low, rough)`,
    "",
    "| Step | Provider | Result | Duration |",
    "| --- | --- | --- | --- |",
  ];

  for (const step of input.steps) {
    const provider = step.provider ?? "—";
    const duration = `${(step.durationMs / 1000).toFixed(1)}s`;
    const detail = step.detail ? ` — ${step.detail}` : "";
    lines.push(`| ${step.label} | ${provider} | ${step.status}${detail} | ${duration} |`);
  }

  const failures = input.steps.filter((s) => s.status === "FAIL");
  if (failures.length > 0) {
    lines.push("", "## Failure evidence", "");
    for (const step of failures) {
      lines.push(`### ${step.label}`, "");
      if (step.evidence) {
        lines.push("```", step.evidence, "```", "");
      } else if (step.detail) {
        lines.push(step.detail, "");
      }
    }
  }

  return `${lines.join("\n")}\n`;
}

export function formatReportTableStdout(input: SmokeReportInput): string {
  const header = input.overallPass ? "SYNC SMOKE: PASS" : "SYNC SMOKE: FAIL";
  const rows = input.steps.map(
    (s) =>
      `  ${s.status.padEnd(4)} ${s.label.padEnd(28)} ${(s.durationMs / 1000).toFixed(1).padStart(5)}s` +
      (s.detail ? `  ${s.detail}` : ""),
  );
  return [header, ...rows].join("\n");
}

export function formatFailuresStderr(steps: ReadonlyArray<SmokeStepResult>): string {
  const failures = steps.filter((s) => s.status === "FAIL");
  if (failures.length === 0) return "";
  const lines: string[] = ["sync-smoke failures:"];
  for (const step of failures) {
    lines.push(`  [${step.label}] ${step.detail ?? "failed"}`);
    if (step.evidence) lines.push(step.evidence);
  }
  return `${lines.join("\n")}\n`;
}
