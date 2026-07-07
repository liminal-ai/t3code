import {
  ClaudeSwapError,
  type ClaudeSwapController,
  type CompactThreadOptions,
  type PruneThreadOptions,
} from "./swap/claude.ts";

export interface LhcHttpRequest {
  method: string;
  pathname: string;
  body?: unknown;
}

export interface LhcHttpResponse {
  status: number;
  body: unknown;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): LhcHttpResponse {
  return {
    status,
    body: {
      ok: false,
      error: {
        code,
        message,
        ...extra,
      },
    },
  };
}

function jsonOk(body: unknown, status = 200): LhcHttpResponse {
  return { status, body: { ok: true, value: body } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeThreadPath(
  pathname: string,
):
  | { kind: "status" }
  | { kind: "thread"; t3ThreadId: string; action: "inspect" | "compact" | "prune" }
  | undefined {
  if (pathname === "/lhc/status") return { kind: "status" };
  const match = /^\/lhc\/threads\/([^/]+)(?:\/(compact|prune))?$/u.exec(pathname);
  if (match === null) return undefined;
  const t3ThreadId = decodeURIComponent(match[1] ?? "");
  if (t3ThreadId.trim() === "") return undefined;
  const action = match[2] === "compact" || match[2] === "prune" ? match[2] : "inspect";
  return { kind: "thread", t3ThreadId, action };
}

function compactOptions(body: unknown): CompactThreadOptions {
  if (!isRecord(body)) return {};
  const options: CompactThreadOptions = {};
  if (typeof body.profile === "string" && body.profile.trim() !== "") {
    options.profile = body.profile;
  }
  if (isRecord(body.params)) {
    const params = body.params as CompactThreadOptions["params"];
    if (params !== undefined) options.params = params;
  }
  if (isRecord(body.options)) {
    if (typeof body.options.profile === "string" && body.options.profile.trim() !== "") {
      options.profile = body.options.profile;
    }
    if (isRecord(body.options.params)) {
      const params = body.options.params as CompactThreadOptions["params"];
      if (params !== undefined) options.params = params;
    }
  }
  return options;
}

function pruneOptions(body: unknown): PruneThreadOptions {
  if (!isRecord(body)) return {};
  const options: PruneThreadOptions = {};
  const target =
    typeof body.targetTokens === "number"
      ? body.targetTokens
      : isRecord(body.options) && typeof body.options.targetTokens === "number"
        ? body.options.targetTokens
        : undefined;
  if (target !== undefined) options.targetTokens = target;
  return options;
}

function mapSwapError(error: ClaudeSwapError): LhcHttpResponse {
  const extra = {
    stepReached: error.stepReached,
    retriable: error.retriable,
    ...(error.detail !== undefined ? { detail: error.detail } : {}),
  };
  if (error.code === "not_captured") {
    return jsonError(404, error.code, error.message, extra);
  }
  if (error.code === "capture_disabled") {
    return jsonError(503, error.code, error.message, extra);
  }
  if (
    error.code === "busy" ||
    error.code === "swap_in_progress" ||
    error.code === "flip_contested" ||
    error.code === "missing_provider_binding" ||
    error.code === "unsupported_provider"
  ) {
    return jsonError(409, error.code, error.message, extra);
  }
  return jsonError(500, error.code, error.message, extra);
}

export async function handleLhcHttpRequest(
  controller: ClaudeSwapController,
  request: LhcHttpRequest,
): Promise<LhcHttpResponse> {
  const route = decodeThreadPath(request.pathname);
  if (route === undefined) {
    return jsonError(404, "not_found", "LHC route not found.");
  }

  try {
    if (route.kind === "status") {
      if (request.method !== "GET") return jsonError(405, "method_not_allowed", "Use GET.");
      return jsonOk(await controller.status());
    }

    if (route.action === "inspect") {
      if (request.method !== "GET") return jsonError(405, "method_not_allowed", "Use GET.");
      return jsonOk(await controller.inspectThread(route.t3ThreadId));
    }
    if (route.action === "compact") {
      if (request.method !== "POST") return jsonError(405, "method_not_allowed", "Use POST.");
      return jsonOk(await controller.compactThread(route.t3ThreadId, compactOptions(request.body)));
    }
    if (request.method !== "POST") return jsonError(405, "method_not_allowed", "Use POST.");
    return jsonOk(await controller.pruneThread(route.t3ThreadId, pruneOptions(request.body)));
  } catch (cause) {
    if (cause instanceof ClaudeSwapError) return mapSwapError(cause);
    return jsonError(500, "internal_error", cause instanceof Error ? cause.message : String(cause));
  }
}
