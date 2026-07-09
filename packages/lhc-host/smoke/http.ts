// @effect-diagnostics globalTimers:off
/**
 * /lhc HTTP helpers distilled from probes/phase2-acceptance.ts.
 */

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

export async function lhcGet(origin: string, bearer: string, path: string): Promise<HttpResult> {
  const res = await fetch(`${origin}${path}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export async function lhcPost(
  origin: string,
  bearer: string,
  path: string,
  payload: unknown = {},
): Promise<HttpResult> {
  const res = await fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export function receiptOf(result: HttpResult): Record<string, unknown> | undefined {
  return isRecord(result.body) && isRecord(result.body.value)
    ? (result.body.value as Record<string, unknown>)
    : undefined;
}

export function derivationFromInspect(body: unknown): { failed: number; blocked: number } {
  if (!isRecord(body) || !isRecord(body.value)) return { failed: -1, blocked: -1 };
  const value = body.value;
  const viewStatus = isRecord(value.viewStatus) ? value.viewStatus : undefined;
  const derivation =
    viewStatus && isRecord(viewStatus.derivation) ? viewStatus.derivation : undefined;
  if (!derivation) return { failed: -1, blocked: -1 };
  return {
    failed: typeof derivation.failed === "number" ? derivation.failed : -1,
    blocked: typeof derivation.blocked === "number" ? derivation.blocked : -1,
  };
}

export function formatHttpEvidence(result: HttpResult): string {
  return `HTTP ${String(result.status)}\n${JSON.stringify(result.body, null, 2)}`;
}
