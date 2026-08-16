#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsoleInEffect:off preferSchemaOverJson:off

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  type ProviderRuntimeEvent,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../src/config.ts";
import { makeClaudeAdapter } from "../src/provider/Layers/ClaudeAdapter.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");
const MODEL_SELECTION = createModelSelection(CLAUDE_INSTANCE, "claude-haiku-4-5");
const THREAD_ID = ThreadId.make("claude-adapter-dogfood");

class ClaudeAdapterDogfoodTimeoutError extends Schema.TaggedErrorClass<ClaudeAdapterDogfoodTimeoutError>()(
  "ClaudeAdapterDogfoodTimeoutError",
  { turnId: Schema.String },
) {
  override get message(): string {
    return `Claude adapter dogfood timed out waiting for turn '${this.turnId}'.`;
  }
}

class ClaudeAdapterDogfoodContinuityError extends Schema.TaggedErrorClass<ClaudeAdapterDogfoodContinuityError>()(
  "ClaudeAdapterDogfoodContinuityError",
  {
    firstResponse: Schema.String,
    resumedResponse: Schema.String,
    sameResumeSession: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Claude adapter dogfood continuity mismatch (first=${JSON.stringify(this.firstResponse)}, resumed=${JSON.stringify(this.resumedResponse)}, sameResumeSession=${this.sameResumeSession}).`;
  }
}

interface TurnReceipt {
  readonly text: string;
  readonly eventCount: number;
}

const awaitTurn = Effect.fn("claudeAdapterDogfood.awaitTurn")(function* (
  events: Queue.Queue<ProviderRuntimeEvent>,
  turnId: TurnId,
) {
  let streamedText = "";
  let completedText = "";
  let eventCount = 0;

  while (true) {
    const event = yield* Queue.take(events);
    if (event.turnId !== turnId) {
      continue;
    }

    eventCount += 1;
    if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
      streamedText += event.payload.delta;
      continue;
    }
    if (
      event.type === "item.completed" &&
      event.payload.itemType === "assistant_message" &&
      event.payload.detail !== undefined
    ) {
      completedText += event.payload.detail;
      continue;
    }
    if (event.type === "turn.aborted") {
      return yield* new ClaudeAdapterDogfoodContinuityError({
        firstResponse: "",
        resumedResponse: event.payload.reason,
        sameResumeSession: false,
      });
    }
    if (event.type === "turn.completed") {
      return {
        text: (streamedText.length > 0 ? streamedText : completedText).trim(),
        eventCount,
      } satisfies TurnReceipt;
    }
  }
});

const awaitTurnBounded = (
  events: Queue.Queue<ProviderRuntimeEvent>,
  turnId: TurnId,
): Effect.Effect<
  TurnReceipt,
  ClaudeAdapterDogfoodTimeoutError | ClaudeAdapterDogfoodContinuityError
> =>
  awaitTurn(events, turnId).pipe(
    Effect.timeoutOption("60 seconds"),
    Effect.flatMap(
      Option.match({
        onNone: () => new ClaudeAdapterDogfoodTimeoutError({ turnId: String(turnId) }),
        onSome: Effect.succeed,
      }),
    ),
  );

const workspaceRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-dogfood-"));
const serverBaseDir = NodePath.join(workspaceRoot, "server");
NodeFS.mkdirSync(serverBaseDir, { recursive: true });

const dogfoodLayer = Layer.mergeAll(
  ServerConfig.layerTest(workspaceRoot, serverBaseDir),
  ServerSettingsService.layerTest(),
).pipe(Layer.provideMerge(NodeServices.layer));

const program = Effect.scoped(
  Effect.gen(function* () {
    const adapter = yield* makeClaudeAdapter(decodeClaudeSettings({}));
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();

    yield* Stream.runForEach(adapter.streamEvents, (event) => Queue.offer(events, event)).pipe(
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() => adapter.stopAll().pipe(Effect.ignore));

    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: CLAUDE_DRIVER,
      providerInstanceId: CLAUDE_INSTANCE,
      cwd: workspaceRoot,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
    });
    const firstTurn = yield* adapter.sendTurn({
      threadId: THREAD_ID,
      input: "Reply with exactly the single word ALPHA.",
      modelSelection: MODEL_SELECTION,
    });
    const first = yield* awaitTurnBounded(events, firstTurn.turnId);

    const activeAfterFirst = yield* adapter.listSessions();
    const firstResumeCursor = activeAfterFirst.find(
      (session) => session.threadId === THREAD_ID,
    )?.resumeCursor;
    yield* adapter.stopAll();

    yield* adapter.startSession({
      threadId: THREAD_ID,
      provider: CLAUDE_DRIVER,
      providerInstanceId: CLAUDE_INSTANCE,
      cwd: workspaceRoot,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "approval-required",
      ...(firstResumeCursor !== undefined ? { resumeCursor: firstResumeCursor } : {}),
    });
    const resumedTurn = yield* adapter.sendTurn({
      threadId: THREAD_ID,
      input: "Reply with exactly the single word you gave in your previous answer.",
      modelSelection: MODEL_SELECTION,
    });
    const resumed = yield* awaitTurnBounded(events, resumedTurn.turnId);
    const activeAfterResume = yield* adapter.listSessions();

    const firstResumeSession =
      typeof firstResumeCursor === "object" && firstResumeCursor !== null
        ? (firstResumeCursor as { readonly resume?: unknown }).resume
        : undefined;
    const resumedCursor = activeAfterResume.find(
      (session) => session.threadId === THREAD_ID,
    )?.resumeCursor;
    const resumedResumeSession =
      typeof resumedCursor === "object" && resumedCursor !== null
        ? (resumedCursor as { readonly resume?: unknown }).resume
        : undefined;
    const sameResumeSession =
      typeof firstResumeSession === "string" && firstResumeSession === resumedResumeSession;

    if (first.text !== "ALPHA" || resumed.text !== "ALPHA" || !sameResumeSession) {
      return yield* new ClaudeAdapterDogfoodContinuityError({
        firstResponse: first.text,
        resumedResponse: resumed.text,
        sameResumeSession,
      });
    }

    return {
      ok: true,
      provider: CLAUDE_DRIVER,
      firstResponse: first.text,
      resumedResponse: resumed.text,
      sameResumeSession,
      firstTurnEvents: first.eventCount,
      resumedTurnEvents: resumed.eventCount,
    } as const;
  }),
).pipe(
  Effect.provide(dogfoodLayer),
  Effect.tap((receipt) => Effect.sync(() => console.log(JSON.stringify(receipt)))),
  Effect.ensuring(
    Effect.sync(() => {
      NodeFS.rmSync(workspaceRoot, { recursive: true, force: true });
    }),
  ),
);

NodeRuntime.runMain(program);
