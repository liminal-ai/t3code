// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
/**
 * control-autocompact — Slice 2.4 item 6 control.
 *
 * Connects, creates a Claude thread, runs ONE cheap turn, and dumps every
 * context-window (token-usage) snapshot's `compactsAutomatically` value. Used to
 * prove the suppression flag: with T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0 the value
 * should be `true` (native auto-compact left on); the default run reports
 * `false`.
 *
 *   node --import ./ts-js-resolve-hook.mjs control-autocompact.ts \
 *     --auth <driver-auth.json> --repo <scratch repo> [--out FILE]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";

import {
  connectDriver,
  createProjectAndThread,
  mintWsTicket,
  runTurn,
  startThreadMonitor,
  stopSession,
  type ThreadMonitor,
} from "./ws-driver.ts";

function scratchRepo(dir: string): string {
  NodeFS.mkdirSync(dir, { recursive: true });
  const run = (args: ReadonlyArray<string>): void =>
    NodeChildProcess.execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  if (!NodeFS.existsSync(NodePath.join(dir, ".git"))) {
    run(["init"]);
    run(["config", "user.email", "probe@example.invalid"]);
    run(["config", "user.name", "LHC Probe"]);
    NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# ctrl\n");
    run(["add", "README.md"]);
    run(["commit", "-m", "seed"]);
  }
  return dir;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function compactsValues(monitor: ThreadMonitor): Array<boolean | undefined> {
  const out: Array<boolean | undefined> = [];
  for (const item of monitor.items) {
    if (!isRecord(item) || item.kind !== "event" || !isRecord(item.event)) continue;
    const event = item.event;
    if (event.type !== "thread.activity-appended" || !isRecord(event.payload)) continue;
    const activity = (event.payload as { activity?: unknown }).activity;
    if (!isRecord(activity) || activity.kind !== "context-window.updated") continue;
    const p = activity.payload;
    if (!isRecord(p)) continue;
    out.push(typeof p.compactsAutomatically === "boolean" ? p.compactsAutomatically : undefined);
  }
  return out;
}

function arg(flags: string[], key: string): string | undefined {
  const i = flags.indexOf(`--${key}`);
  return i >= 0 ? flags[i + 1] : undefined;
}

async function main(): Promise<void> {
  const flags = process.argv.slice(2);
  const authFile = arg(flags, "auth");
  const repo = arg(flags, "repo");
  const outFile = arg(flags, "out");
  if (!authFile || !repo) throw new Error("need --auth --repo");
  const auth = JSON.parse(NodeFS.readFileSync(authFile, "utf8")) as {
    origin: string;
    accessToken: string;
  };
  const workspaceRoot = scratchRepo(repo);
  const ticket = await mintWsTicket(auth.origin, auth.accessToken);

  let result: Record<string, unknown> = {};
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* connectDriver(auth.origin, ticket);
        const created = yield* createProjectAndThread(handle, {
          workspaceRoot,
          provider: "claude",
          title: "lhc-2.4 autocompact control",
        });
        const monitor = yield* startThreadMonitor(handle, created.threadId);
        yield* Effect.sleep("500 millis");
        const turn = yield* runTurn(handle, monitor, {
          threadId: created.threadId,
          // small tool output so a context-window snapshot is emitted
          text: "Run the shell command `seq 1 200` then reply with exactly `ok`.",
          provider: "claude",
          timeoutMs: 120_000,
        });
        const values = compactsValues(monitor);
        result = {
          threadId: created.threadId,
          finalStatus: turn.finalStatus,
          compactsAutomaticallyValues: values,
          distinct: Array.from(new Set(values)),
        };
        yield* stopSession(handle, created.threadId).pipe(Effect.ignore);
        yield* Effect.sleep("1000 millis");
      }),
    ) as Effect.Effect<void, unknown, never>,
  );

  console.log(JSON.stringify(result, null, 2));
  if (outFile) NodeFS.writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`);
}

main().then(
  () => setTimeout(() => process.exit(0), 150),
  (e: unknown) => {
    console.error(e);
    process.exit(1);
  },
);
