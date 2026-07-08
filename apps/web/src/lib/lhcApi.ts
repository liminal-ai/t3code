import type { ThreadId } from "@t3tools/contracts";

import { readDesktopPrimaryBearerToken } from "../environments/primary/desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary/target";
import { formatContextWindowTokens } from "./contextWindow";

type JsonRecord = Record<string, unknown>;

let lhcRoutesUnavailable = false;

export function isLhcRoutesUnavailable(): boolean {
  return lhcRoutesUnavailable;
}

export function __resetLhcRoutesUnavailableForTests(): void {
  lhcRoutesUnavailable = false;
}

function markLhcRoutesUnavailable(): void {
  lhcRoutesUnavailable = true;
}

export type LhcStatusThreadSummary = {
  readonly t3ThreadId: string;
  readonly lhcThreadId: string;
  readonly providerKind: string;
};

export type LhcStatusResponse = {
  readonly threads: ReadonlyArray<LhcStatusThreadSummary>;
};

export type LhcThreadInspectResponse = {
  readonly t3ThreadId: string;
  readonly lhcThreadId: string;
  readonly providerKind: string;
  readonly tailTokens: number;
  readonly compactRecommended: boolean;
};

export type LhcSwapReceipt = {
  readonly op: "compact" | "prune";
  readonly lhcResult: unknown;
};

export class LhcApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly stepReached: string | undefined;

  constructor(input: {
    readonly status: number;
    readonly code: string;
    readonly message?: string;
    readonly stepReached?: string;
  }) {
    super(input.message ?? input.code);
    this.name = "LhcApiError";
    this.status = input.status;
    this.code = input.code;
    this.stepReached = input.stepReached;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    window.nativeApi !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

async function resolveLhcRequestInit(init?: RequestInit): Promise<RequestInit> {
  const bearerToken = await readDesktopPrimaryBearerToken();
  const headers = new Headers(init?.headers);
  if (bearerToken) {
    headers.set("Authorization", `Bearer ${bearerToken}`);
  }
  return {
    ...init,
    headers,
    credentials: isSameOriginBrowserPrimary() ? "include" : "omit",
  };
}

export type LhcFetch = typeof fetch;

export function isLhcRouteLevelFailure(error: unknown): boolean {
  if (error instanceof LhcApiError) {
    return error.code === "invalid_response" && error.status === 404;
  }
  return error instanceof TypeError;
}

async function lhcRequest<T>(
  pathname: string,
  init: RequestInit,
  fetchImpl: LhcFetch = fetch,
): Promise<T> {
  if (lhcRoutesUnavailable) {
    throw new LhcApiError({
      status: 0,
      code: "lhc_unavailable",
      message: "LHC routes are unavailable.",
    });
  }

  const url = resolvePrimaryEnvironmentHttpUrl(pathname);
  const requestInit = await resolveLhcRequestInit(init);
  let response: Response;
  try {
    response = await fetchImpl(url, requestInit);
  } catch (cause) {
    markLhcRoutesUnavailable();
    throw cause;
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.status === 404) {
      markLhcRoutesUnavailable();
    }
    throw new LhcApiError({
      status: response.status,
      code: "invalid_response",
      message: "LHC response was not JSON.",
    });
  }

  if (!isRecord(body)) {
    throw new LhcApiError({
      status: response.status,
      code: "invalid_response",
      message: "LHC response was not an object.",
    });
  }

  if (body.ok === true) {
    return body.value as T;
  }

  const error = isRecord(body.error) ? body.error : {};
  throw new LhcApiError({
    status: response.status,
    code: typeof error.code === "string" ? error.code : "unknown",
    ...(typeof error.message === "string" ? { message: error.message } : {}),
    ...(typeof error.stepReached === "string" ? { stepReached: error.stepReached } : {}),
  });
}

export function formatLhcActionError(error: LhcApiError): string {
  if (error.code === "busy") {
    return "Wait for the current turn to finish";
  }
  if (error.code === "flip_contested") {
    return "Contested — try again";
  }
  if (error.stepReached) {
    return `${error.code} (${error.stepReached})`;
  }
  return error.code;
}

export function formatLhcSuccessToast(
  op: "compact" | "prune",
  receipt: LhcSwapReceipt,
): { readonly title: string; readonly description?: string } {
  const title = op === "compact" ? "Compacted — new session ready" : "Pruned — new session ready";
  const lhcResult = isRecord(receipt.lhcResult) ? receipt.lhcResult : null;
  const detailParts: string[] = [];
  const zoneTokensAfter = lhcResult ? asFiniteNumber(lhcResult.zoneTokensAfter) : null;
  const totalTokens = lhcResult ? asFiniteNumber(lhcResult.totalTokens) : null;
  if (zoneTokensAfter !== null) {
    detailParts.push(`${formatContextWindowTokens(zoneTokensAfter)} zone tokens`);
  }
  if (totalTokens !== null) {
    detailParts.push(`${formatContextWindowTokens(totalTokens)} total`);
  }
  return detailParts.length > 0 ? { title, description: detailParts.join(" · ") } : { title };
}

export async function fetchLhcStatus(fetchImpl?: LhcFetch): Promise<LhcStatusResponse> {
  return lhcRequest<LhcStatusResponse>("/lhc/status", { method: "GET" }, fetchImpl);
}

export async function fetchLhcThreadInspect(
  threadId: ThreadId,
  fetchImpl?: LhcFetch,
): Promise<LhcThreadInspectResponse> {
  return lhcRequest<LhcThreadInspectResponse>(
    `/lhc/threads/${encodeURIComponent(threadId)}`,
    { method: "GET" },
    fetchImpl,
  );
}

export async function postLhcCompact(
  threadId: ThreadId,
  fetchImpl?: LhcFetch,
): Promise<LhcSwapReceipt> {
  return lhcRequest<LhcSwapReceipt>(
    `/lhc/threads/${encodeURIComponent(threadId)}/compact`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    fetchImpl,
  );
}

export async function postLhcPrune(
  threadId: ThreadId,
  fetchImpl?: LhcFetch,
): Promise<LhcSwapReceipt> {
  return lhcRequest<LhcSwapReceipt>(
    `/lhc/threads/${encodeURIComponent(threadId)}/prune`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
    fetchImpl,
  );
}
