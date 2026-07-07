// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
/**
 * ws-driver — a small, reusable driver that exercises the t3code server the way
 * a real (non-browser) client does: it authenticates, opens the `/ws` RPC
 * socket, dispatches orchestration commands (`thread.turn.start`,
 * `thread.turn.interrupt`, `thread.session.stop`), and watches
 * `orchestration.subscribeThread` pushes to know when a turn opens/closes.
 *
 * Written for Slice 1.3 live-capture validation and intended to be reused by
 * Slice 2.x. Runs from source under Node's native type-stripping via the
 * sibling `ts-js-resolve-hook.mjs` (`node --import ./ts-js-resolve-hook.mjs`).
 *
 * Auth recipe (loopback, no browser):
 *   1. `serve` prints a one-time startup pairing credential ("Token: ...").
 *   2. POST /oauth/token (token-exchange grant) -> Bearer access_token.
 *   3. POST /api/auth/websocket-ticket (Bearer) -> short-lived ws ticket.
 *   4. connect ws://host:port/ws?wsTicket=<ticket> (global WebSocket carries no
 *      headers, so the ticket rides the query string — the server's
 *      `authenticateWebSocketUpgrade` path).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/unstable/rpc";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import {
  makeWsRpcProtocolClient,
  type WsRpcProtocolClient,
} from "../../client-runtime/src/rpc/protocol.ts";

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const uuid = (): string => globalThis.crypto.randomUUID();
const nowIso = (): string => new Date().toISOString();

export interface ServerRuntimeState {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly pid: number;
}

/** Read `<baseDir>/userdata/server-runtime.json` to discover the live origin. */
export function resolveRuntimeState(baseDir: string): ServerRuntimeState {
  const file = NodePath.join(baseDir, "userdata", "server-runtime.json");
  const raw = JSON.parse(NodeFS.readFileSync(file, "utf8")) as {
    host: string;
    port: number;
    origin: string;
    pid: number;
  };
  return { host: raw.host, port: raw.port, origin: raw.origin, pid: raw.pid };
}

// ---------------------------------------------------------------------------
// Auth (plain fetch — no effect machinery required)
// ---------------------------------------------------------------------------
//
// Headless auth path (matches `t3 connect`): a bearer session token is minted
// in-process by the server bin — `t3 auth session issue --token-only
// --base-dir <dir>` — which signs it with the server's on-disk secret and
// records the session row in the shared sqlite. We exchange that bearer for a
// short-lived WebSocket ticket, because the global `WebSocket` used by the RPC
// socket cannot attach an Authorization header; the ticket rides the `?wsTicket`
// query param instead. (The browser `/oauth/token` startup-credential exchange
// is a different, browser-oriented path and is intentionally not used here.)

/** Exchange a bearer session token for a short-lived WebSocket ticket. */
export async function mintWsTicket(origin: string, bearerToken: string): Promise<string> {
  const res = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearerToken}` },
  });
  if (!res.ok) {
    throw new Error(`ws ticket failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { ticket: string };
  return json.ticket;
}

// ---------------------------------------------------------------------------
// Model selections
// ---------------------------------------------------------------------------

export type ProviderName = "claude" | "codex";

export interface ModelSelectionLite {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ id: string; value: string | boolean }>;
}

export function modelSelectionFor(
  provider: ProviderName,
  opts: { reasoning?: boolean } = {},
): ModelSelectionLite {
  if (provider === "claude") {
    return {
      instanceId: "claudeAgent",
      model: "claude-haiku-4-5",
      ...(opts.reasoning ? { options: [{ id: "thinking", value: true }] } : {}),
    };
  }
  return { instanceId: "codex", model: "gpt-5.4" };
}

const DRIVER_KIND: Record<ProviderName, string> = {
  claude: "claudeAgent",
  codex: "codex",
};

// ---------------------------------------------------------------------------
// RPC connection
// ---------------------------------------------------------------------------

export interface DriverHandle {
  readonly client: WsRpcProtocolClient;
}

/**
 * Connect to `/ws` and return a typed RPC client bound to the current scope.
 * Closing the scope tears down the socket.
 */
export const connectDriver = (
  origin: string,
  ticket: string,
): Effect.Effect<DriverHandle, unknown, Scope.Scope> =>
  Effect.gen(function* () {
    const wsUrl = `${origin.replace(/^http/, "ws")}/ws?wsTicket=${encodeURIComponent(ticket)}`;
    const webSocketConstructor: Socket.WebSocketConstructor = (url) =>
      new globalThis.WebSocket(url) as unknown as globalThis.WebSocket;

    const socketLayer = Socket.layerWebSocket(wsUrl, { openTimeout: "15 seconds" }).pipe(
      Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)),
    );
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(Layer.provide(Layer.mergeAll(socketLayer, RpcSerialization.layerJson)));

    const protocolContext = yield* Layer.build(protocolLayer);
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    return { client } satisfies DriverHandle;
  });

// ---------------------------------------------------------------------------
// Thread monitor — consumes subscribeThread and tracks turn lifecycle
// ---------------------------------------------------------------------------

interface SessionSnapshot {
  status: string;
  activeTurnId: string | null;
}

export interface ThreadMonitor {
  readonly threadId: string;
  /** Every decoded stream item, in arrival order (snapshot + events). */
  readonly items: ReadonlyArray<unknown>;
  session(): SessionSnapshot;
  /** Resolve once `predicate` holds after some newly-arrived event. */
  waitUntil(predicate: (m: ThreadMonitor) => boolean, timeoutMs: number): Promise<void>;
  eventTypeCounts(): Record<string, number>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/**
 * Fork a subscription for `threadId`. The returned monitor is a plain object
 * whose fields are mutated from the streaming fiber (via Effect.sync), so
 * callers can poll/await it without effect plumbing.
 */
export const startThreadMonitor = (
  handle: DriverHandle,
  threadId: string,
): Effect.Effect<ThreadMonitor, never, Scope.Scope> =>
  Effect.gen(function* () {
    const items: unknown[] = [];
    let session: SessionSnapshot = { status: "idle", activeTurnId: null };
    const listeners = new Set<() => void>();

    const monitor: ThreadMonitor = {
      threadId,
      items,
      session: () => session,
      eventTypeCounts: () => {
        const counts: Record<string, number> = {};
        for (const item of items) {
          if (isRecord(item) && item.kind === "event" && isRecord(item.event)) {
            const t = String(item.event.type);
            counts[t] = (counts[t] ?? 0) + 1;
          }
        }
        return counts;
      },
      waitUntil: (predicate, timeoutMs) =>
        new Promise<void>((resolve, reject) => {
          const check = (): boolean => {
            if (predicate(monitor)) {
              resolve();
              return true;
            }
            return false;
          };
          if (check()) return;
          const listener = (): void => {
            if (check()) {
              listeners.delete(listener);
              clearTimeout(timer);
            }
          };
          const timer = setTimeout(() => {
            listeners.delete(listener);
            reject(
              new Error(
                `waitUntil timed out after ${String(timeoutMs)}ms; session=${JSON.stringify(session)}`,
              ),
            );
          }, timeoutMs);
          listeners.add(listener);
        }),
    };

    const onItem = (item: unknown): void => {
      items.push(item);
      if (isRecord(item)) {
        if (item.kind === "snapshot" && isRecord(item.snapshot)) {
          const thread = (item.snapshot as { thread?: unknown }).thread;
          if (isRecord(thread) && isRecord(thread.session)) {
            session = {
              status: String(thread.session.status),
              activeTurnId: (thread.session.activeTurnId as string | null) ?? null,
            };
          }
        } else if (item.kind === "event" && isRecord(item.event)) {
          const event = item.event;
          if (event.type === "thread.session-set" && isRecord(event.payload)) {
            const s = (event.payload as { session?: unknown }).session;
            if (isRecord(s)) {
              session = {
                status: String(s.status),
                activeTurnId: (s.activeTurnId as string | null) ?? null,
              };
            }
          }
        }
      }
      for (const listener of [...listeners]) listener();
    };

    const stream = handle.client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId });
    yield* Effect.forkScoped(
      Stream.runForEach(stream, (item: unknown) => Effect.sync(() => onItem(item))).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            // Surface subscription death but never crash the driver.
            console.error(`[monitor ${threadId}] stream stopped:`, String(cause));
          }),
        ),
      ),
    );

    return monitor;
  });

// ---------------------------------------------------------------------------
// Command dispatch helpers
// ---------------------------------------------------------------------------

const dispatch = (
  handle: DriverHandle,
  command: unknown,
): Effect.Effect<{ sequence: number }, unknown> =>
  handle.client[ORCHESTRATION_WS_METHODS.dispatchCommand](
    command as never,
  ) as unknown as Effect.Effect<{ sequence: number }, unknown>;

export interface CreatedThread {
  readonly projectId: string;
  readonly threadId: string;
}

/** Create a project rooted at `workspaceRoot` and a thread inside it. */
export const createProjectAndThread = (
  handle: DriverHandle,
  opts: {
    workspaceRoot: string;
    provider: ProviderName;
    title?: string;
    reasoning?: boolean;
  },
): Effect.Effect<CreatedThread, unknown> =>
  Effect.gen(function* () {
    const projectId = uuid();
    const threadId = uuid();
    const modelSelection = modelSelectionFor(opts.provider, { reasoning: opts.reasoning });
    const title = opts.title ?? `lhc-1.3 ${opts.provider}`;

    yield* dispatch(handle, {
      type: "project.create",
      commandId: uuid(),
      projectId,
      title,
      workspaceRoot: opts.workspaceRoot,
      defaultModelSelection: modelSelection,
      createdAt: nowIso(),
    });

    yield* dispatch(handle, {
      type: "thread.create",
      commandId: uuid(),
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: nowIso(),
    });

    return { projectId, threadId };
  });

export interface TurnResult {
  readonly turnId: string | null;
  readonly finalStatus: string;
  readonly interrupted: boolean;
}

const BUSY = new Set(["starting", "running"]);

/**
 * Dispatch one user turn and wait until the session goes busy then settles.
 * When `interruptAfterMs` is set, the active turn is interrupted after the
 * session goes busy.
 */
export const runTurn = (
  handle: DriverHandle,
  monitor: ThreadMonitor,
  opts: {
    threadId: string;
    text: string;
    provider: ProviderName;
    reasoning?: boolean;
    interruptAfterMs?: number;
    timeoutMs?: number;
  },
): Effect.Effect<TurnResult, unknown> =>
  Effect.gen(function* () {
    const timeoutMs = opts.timeoutMs ?? 240_000;
    const modelSelection = modelSelectionFor(opts.provider, { reasoning: opts.reasoning });

    yield* dispatch(handle, {
      type: "thread.turn.start",
      commandId: uuid(),
      threadId: opts.threadId,
      message: { messageId: uuid(), role: "user", text: opts.text, attachments: [] },
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: nowIso(),
    });

    // Wait for the turn to open (session becomes busy with an active turn id).
    yield* Effect.promise(() =>
      monitor
        .waitUntil((m) => m.session().activeTurnId !== null && BUSY.has(m.session().status), 60_000)
        .catch(() => undefined),
    );
    const turnId = monitor.session().activeTurnId;

    let interrupted = false;
    if (opts.interruptAfterMs !== undefined) {
      yield* Effect.sleep(`${opts.interruptAfterMs} millis`);
      yield* dispatch(handle, {
        type: "thread.turn.interrupt",
        commandId: uuid(),
        threadId: opts.threadId,
        ...(turnId ? { turnId } : {}),
        createdAt: nowIso(),
      });
      interrupted = true;
    }

    // Wait for the turn to settle: no active turn and not busy.
    yield* Effect.promise(() =>
      monitor.waitUntil(
        (m) => m.session().activeTurnId === null && !BUSY.has(m.session().status),
        timeoutMs,
      ),
    );

    return { turnId, finalStatus: monitor.session().status, interrupted };
  });

export const stopSession = (
  handle: DriverHandle,
  threadId: string,
): Effect.Effect<{ sequence: number }, unknown> =>
  dispatch(handle, {
    type: "thread.session.stop",
    commandId: uuid(),
    threadId,
    createdAt: nowIso(),
  });

// Re-export for CLI scenarios that build raw commands.
export { dispatch, uuid, nowIso, DRIVER_KIND };
