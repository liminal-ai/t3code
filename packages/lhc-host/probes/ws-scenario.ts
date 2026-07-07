// @effect-diagnostics globalTimers:off globalDate:off globalConsole:off
/**
 * ws-scenario — CLI wrapper around ws-driver for Slice 1.3 live validation.
 *
 * Two subcommands:
 *
 *   auth   --base-dir DIR --startup-token TOKEN --out FILE
 *     Exchange the one-time startup pairing credential for a reusable Bearer
 *     access token and cache {origin, accessToken} to FILE. Run once per server
 *     boot (the startup token is single-use).
 *
 *   run    --auth FILE --provider claude|codex --repo DIR
 *          --turns label1,label2 [--thread-id ID] [--project-id ID]
 *          [--out FILE] [--keep-open]
 *     Mint a fresh ws ticket from the cached access token, connect, create a
 *     project+thread (or reuse --thread-id for the restart/resume path), run
 *     the named turns, and write a JSON result (t3 threadId, per-turn turnIds,
 *     event-type counts, final status).
 *
 * Run under the resolve hook, e.g.:
 *   node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs \
 *     packages/lhc-host/probes/ws-scenario.ts run --auth ... --provider claude ...
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import * as Effect from "effect/Effect";

import {
  connectDriver,
  createProjectAndThread,
  mintWsTicket,
  resolveRuntimeState,
  runTurn,
  startThreadMonitor,
  stopSession,
  type ProviderName,
  type TurnResult,
} from "./ws-driver.ts";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: ReadonlyArray<string>): {
  command: string;
  flags: Map<string, string | true>;
} {
  const command = argv[2] ?? "";
  const flags = new Map<string, string | true>();
  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags.set(key, inline);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags.set(key, next);
      i += 1;
    } else {
      flags.set(key, true);
    }
  }
  return { command, flags };
}

const str = (flags: Map<string, string | true>, key: string): string | undefined => {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
};

// ---------------------------------------------------------------------------
// Turn presets
// ---------------------------------------------------------------------------

interface TurnPreset {
  readonly label: string;
  readonly prompt: string;
  readonly reasoning?: boolean;
  readonly interruptAfterMs?: number;
  readonly timeoutMs?: number;
}

const TURN_PRESETS: Record<string, TurnPreset> = {
  reasoning: {
    label: "reasoning",
    prompt:
      "Think step by step about whether 91 is prime, then answer with exactly `91 prime: no` and no extra prose.",
    reasoning: true,
  },
  seq: {
    label: "seq",
    prompt:
      "Run the shell command `seq 1 20000` in this repo. After it finishes, reply with exactly `last number: 20000` and nothing else.",
    timeoutMs: 300_000,
  },
  edit: {
    label: "edit",
    prompt:
      "Create or overwrite a file named lhc-probe.txt with the exact contents `lhc live capture probe` followed by a newline. Then reply with exactly `wrote lhc-probe.txt`.",
  },
  hi: {
    label: "hi",
    prompt: "Reply with exactly `hi` and nothing else.",
  },
  small: {
    label: "small",
    prompt: "Reply with exactly `ok` and nothing else.",
  },
  slow: {
    label: "slow",
    prompt:
      "Run this shell command exactly and wait for it: `for i in $(seq 1 120); do echo slow-$i; sleep 1; done`. Do not stop until it completes.",
    interruptAfterMs: 6_000,
    timeoutMs: 120_000,
  },
};

// ---------------------------------------------------------------------------
// Scratch repo helper
// ---------------------------------------------------------------------------

export function makeScratchRepo(dir: string): string {
  NodeFS.mkdirSync(dir, { recursive: true });
  const run = (args: ReadonlyArray<string>): void => {
    NodeChildProcess.execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  };
  if (!NodeFS.existsSync(NodePath.join(dir, ".git"))) {
    run(["init"]);
    run(["config", "user.email", "probe@example.invalid"]);
    run(["config", "user.name", "LHC Probe"]);
    NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "# lhc scratch repo\n");
    run(["add", "README.md"]);
    run(["commit", "-m", "seed"]);
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdAuth(flags: Map<string, string | true>): Promise<void> {
  const baseDir = str(flags, "base-dir");
  const out = str(flags, "out");
  if (!baseDir) throw new Error("auth needs --base-dir");
  const runtime = resolveRuntimeState(baseDir);
  // Prefer an explicitly-supplied bearer; otherwise mint one via the server bin
  // (`t3 auth session issue --token-only`), which shares this process's node +
  // resolve-hook invocation.
  let bearer = str(flags, "bearer");
  if (!bearer) {
    const binEntry = NodePath.resolve(
      NodePath.dirname(new URL(import.meta.url).pathname),
      "../../../apps/server/src/bin.ts",
    );
    const hook = NodePath.resolve(
      NodePath.dirname(new URL(import.meta.url).pathname),
      "ts-js-resolve-hook.mjs",
    );
    bearer = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "--import",
        hook,
        binEntry,
        "auth",
        "session",
        "issue",
        "--token-only",
        "--base-dir",
        baseDir,
      ],
      { encoding: "utf8" },
    ).trim();
  }
  const record = {
    origin: runtime.origin,
    accessToken: bearer,
    mintedAt: new Date().toISOString(),
  };
  const target = out ?? NodePath.join(baseDir, "driver-auth.json");
  NodeFS.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`wrote ${target} (origin ${runtime.origin})`);
}

async function cmdRun(flags: Map<string, string | true>): Promise<void> {
  const authFile = str(flags, "auth");
  const provider = str(flags, "provider") as ProviderName | undefined;
  const repo = str(flags, "repo");
  const turnsArg = str(flags, "turns");
  if (!authFile || !provider || !repo || !turnsArg) {
    throw new Error("run needs --auth --provider --repo --turns");
  }
  const auth = JSON.parse(NodeFS.readFileSync(authFile, "utf8")) as {
    origin: string;
    accessToken: string;
  };
  const workspaceRoot = makeScratchRepo(repo);
  const turnLabels = turnsArg.split(",").map((s) => s.trim());
  const presets = turnLabels.map((label) => {
    const preset = TURN_PRESETS[label];
    if (!preset) throw new Error(`unknown turn preset: ${label}`);
    return preset;
  });
  const reasoningWanted = presets.some((p) => p.reasoning);
  const reuseThreadId = str(flags, "thread-id");
  const reuseProjectId = str(flags, "project-id");
  const keepOpen = flags.get("keep-open") === true;
  const outFile = str(flags, "out");

  const ticket = await mintWsTicket(auth.origin, auth.accessToken);

  const program = Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* connectDriver(auth.origin, ticket);

      let threadId: string;
      let projectId: string;
      if (reuseThreadId) {
        threadId = reuseThreadId;
        projectId = reuseProjectId ?? "(reused)";
      } else {
        const created = yield* createProjectAndThread(handle, {
          workspaceRoot,
          provider,
          reasoning: reasoningWanted,
        });
        threadId = created.threadId;
        projectId = created.projectId;
      }

      const monitor = yield* startThreadMonitor(handle, threadId);
      // Let the initial snapshot land.
      yield* Effect.sleep("500 millis");

      const turnResults: Array<{ label: string } & TurnResult> = [];
      for (const preset of presets) {
        console.log(`[${provider}] turn "${preset.label}" ...`);
        const result = yield* runTurn(handle, monitor, {
          threadId,
          text: preset.prompt,
          provider,
          reasoning: preset.reasoning,
          ...(preset.interruptAfterMs !== undefined
            ? { interruptAfterMs: preset.interruptAfterMs }
            : {}),
          ...(preset.timeoutMs !== undefined ? { timeoutMs: preset.timeoutMs } : {}),
        });
        console.log(
          `[${provider}] turn "${preset.label}" -> ${result.finalStatus} (turnId ${String(result.turnId)})`,
        );
        turnResults.push({ label: preset.label, ...result });
      }

      if (!keepOpen) {
        yield* stopSession(handle, threadId).pipe(Effect.ignore);
        yield* Effect.sleep("1500 millis");
      }

      const record = {
        provider,
        driverKind: provider === "claude" ? "claudeAgent" : "codex",
        origin: auth.origin,
        projectId,
        threadId,
        workspaceRoot,
        turns: turnResults,
        eventTypeCounts: monitor.eventTypeCounts(),
        finalSession: monitor.session(),
        finishedAt: new Date().toISOString(),
      };
      console.log(JSON.stringify(record, null, 2));
      if (outFile) NodeFS.writeFileSync(outFile, `${JSON.stringify(record, null, 2)}\n`);
    }),
  );

  await Effect.runPromise(program as Effect.Effect<void, unknown, never>);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);
  switch (command) {
    case "auth":
      return cmdAuth(flags);
    case "run":
      return cmdRun(flags);
    default:
      throw new Error(`usage: ws-scenario auth|run ... (got "${command}")`);
  }
}

main().then(
  () => {
    // fetch/undici keep-alive can hold the event loop briefly; exit cleanly.
    setTimeout(() => process.exit(0), 100);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
