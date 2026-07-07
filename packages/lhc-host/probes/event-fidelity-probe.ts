// Scratch probe for Slice 0.2 provider event-stream fidelity.
// Excluded from package checks because packages/lhc-host/tsconfig.json includes only src/.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "../../contracts/src/index.ts";
import * as NodeServices from "../../../apps/server/node_modules/@effect/platform-node/dist/NodeServices.js";
import * as Cause from "../../../apps/server/node_modules/effect/dist/Cause.js";
import * as Effect from "../../../apps/server/node_modules/effect/dist/Effect.js";
import * as Exit from "../../../apps/server/node_modules/effect/dist/Exit.js";
import * as Fiber from "../../../apps/server/node_modules/effect/dist/Fiber.js";
import * as Layer from "../../../apps/server/node_modules/effect/dist/Layer.js";
import * as Option from "../../../apps/server/node_modules/effect/dist/Option.js";
import * as Schema from "../../../apps/server/node_modules/effect/dist/Schema.js";
import * as Stream from "../../../apps/server/node_modules/effect/dist/Stream.js";

import { ServerConfig } from "../../../apps/server/src/config.ts";
import { ServerSettingsService } from "../../../apps/server/src/serverSettings.ts";
import { ProviderSessionDirectory } from "../../../apps/server/src/provider/Services/ProviderSessionDirectory.ts";
import { makeClaudeAdapter } from "../../../apps/server/src/provider/Layers/ClaudeAdapter.ts";
import { makeCodexAdapter } from "../../../apps/server/src/provider/Layers/CodexAdapter.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const providerSessionDirectoryProbeLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  getProvider: () => Effect.succeed(Option.none()),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

type ProviderName = "claude" | "codex";

interface ProbeTurn {
  readonly label: string;
  readonly prompt: string;
  readonly interruptAfterMs?: number;
}

interface ProviderConfig {
  readonly name: ProviderName;
  readonly driver: "claudeAgent" | "codex";
  readonly instanceId: string;
}

const providers: Record<ProviderName, ProviderConfig> = {
  claude: {
    name: "claude",
    driver: "claudeAgent",
    instanceId: "claudeAgent",
  },
  codex: {
    name: "codex",
    driver: "codex",
    instanceId: "codex",
  },
};

const turns: ReadonlyArray<ProbeTurn> = [
  {
    label: "large-tool-output",
    prompt:
      "Run `seq 1 20000` in this git repo, then answer with exactly `last number: 20000` and no extra prose.",
  },
  {
    label: "file-edit",
    prompt:
      "Create or overwrite a file named event-fidelity-small.txt with the exact text `event fidelity file edit probe` followed by a newline. Then briefly say what you changed.",
  },
  {
    label: "interrupt",
    prompt:
      "Start a deliberately slow shell command: `for i in $(seq 1 120); do echo slow-$i; sleep 1; done`. Keep it running until interrupted.",
    interruptAfterMs: 2_000,
  },
];

function parseArgs(): {
  readonly provider: ProviderName;
  readonly outDir: string;
  readonly includeInterrupt: boolean;
} {
  const args = new Map<string, string | true>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args.set(key, inlineValue);
      continue;
    }
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, true);
    }
  }

  const rawProvider = args.get("provider");
  if (rawProvider !== "claude" && rawProvider !== "codex") {
    throw new Error(
      "Usage: node packages/lhc-host/probes/event-fidelity-probe.ts --provider claude|codex [--out-dir DIR] [--include-interrupt]",
    );
  }

  const outDir =
    typeof args.get("out-dir") === "string"
      ? String(args.get("out-dir"))
      : NodePath.join(process.cwd(), "packages/lhc-host/test/fixtures/event-fidelity", rawProvider);

  return {
    provider: rawProvider,
    outDir,
    includeInterrupt: args.has("include-interrupt"),
  };
}

function makeScratchRepo(provider: ProviderName): string {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `t3-event-fidelity-${provider}-`));
  NodeChildProcess.execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  NodeChildProcess.execFileSync("git", ["config", "user.email", "probe@example.invalid"], {
    cwd,
  });
  NodeChildProcess.execFileSync("git", ["config", "user.name", "Event Fidelity Probe"], { cwd });
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), `# ${provider} event fidelity probe\n`);
  NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd });
  NodeChildProcess.execFileSync("git", ["commit", "-m", "seed"], { cwd, stdio: "ignore" });
  return cwd;
}

function appendJsonl(filePath: string, value: unknown): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTurn(
  completions: Map<string, { readonly status: string; readonly event: unknown }>,
  turnId: string,
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (completions.has(turnId)) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error(`Timed out waiting for turn ${turnId}`));
        return;
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}

const runProvider = Effect.fn("runProvider")(function* (
  config: ProviderConfig,
  outDir: string,
  includeInterrupt: boolean,
) {
  const cwd = makeScratchRepo(config.name);
  const threadId = ThreadId.make(`event-fidelity-${config.name}-${Date.now()}`);
  const normalizedPath = NodePath.join(outDir, `${config.name}-normalized.full.jsonl`);
  const metaPath = NodePath.join(outDir, `${config.name}-probe-meta.json`);
  const nativeLogPath = NodePath.join(outDir, `${config.name}-native.log`);
  NodeFS.rmSync(normalizedPath, { force: true });
  NodeFS.rmSync(metaPath, { force: true });

  const adapter =
    config.name === "claude"
      ? yield* makeClaudeAdapter(decodeClaudeSettings({}), {
          instanceId: ProviderInstanceId.make(config.instanceId),
          nativeEventLogPath: nativeLogPath,
        })
      : yield* makeCodexAdapter(decodeCodexSettings({}), {
          instanceId: ProviderInstanceId.make(config.instanceId),
          nativeEventLogPath: nativeLogPath,
        });

  const completions = new Map<string, { status: string; event: unknown }>();
  const streamFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
    Effect.sync(() => {
      appendJsonl(normalizedPath, event);
      if ((event.type === "turn.completed" || event.type === "turn.aborted") && event.turnId) {
        completions.set(String(event.turnId), {
          status: event.type,
          event,
        });
      }
    }),
  ).pipe(Effect.forkChild);

  const session = yield* adapter.startSession({
    provider: ProviderDriverKind.make(config.driver),
    providerInstanceId: ProviderInstanceId.make(config.instanceId),
    threadId,
    cwd,
    runtimeMode: "full-access",
  });

  const selectedTurns = includeInterrupt ? turns : turns.filter((turn) => !turn.interruptAfterMs);
  const turnResults: Array<Record<string, unknown>> = [];
  for (const turn of selectedTurns) {
    const start = yield* adapter.sendTurn({
      threadId,
      input: turn.prompt,
      attachments: [],
    });

    if (turn.interruptAfterMs !== undefined) {
      yield* Effect.promise(() => sleep(turn.interruptAfterMs));
      yield* adapter.interruptTurn(threadId, start.turnId);
    }

    yield* Effect.tryPromise(() => waitForTurn(completions, String(start.turnId), 240_000));
    turnResults.push({
      label: turn.label,
      prompt: turn.prompt,
      turnId: start.turnId,
      completion: completions.get(String(start.turnId)),
    });
  }

  yield* adapter.stopSession(threadId).pipe(Effect.ignore);
  yield* Fiber.interrupt(streamFiber).pipe(Effect.ignore);

  NodeFS.writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        provider: config.name,
        driver: config.driver,
        threadId,
        cwd,
        session,
        normalizedPath,
        nativeLogPath,
        turns: turnResults,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
});

const main = Effect.gen(function* () {
  const args = parseArgs();
  yield* runProvider(providers[args.provider], args.outDir, args.includeInterrupt);
}).pipe(
  Effect.provide(
    Layer.mergeAll(
      ServerConfig.layerTest(process.cwd(), process.cwd()),
      ServerSettingsService.layerTest(),
      providerSessionDirectoryProbeLayer,
    ).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

Effect.runPromiseExit(Effect.scoped(main)).then((exit) => {
  if (Exit.isFailure(exit)) {
    console.error(Cause.pretty(exit.cause));
    process.exitCode = 1;
  }
});
