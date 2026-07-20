// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import { deriveClaudeSwapHomePath, deriveClaudeSwapProjectsDir } from "./ClaudeSwapHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses the process home when no Claude home override is configured", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* resolveClaudeHomePath({ homePath: "" })).toBe(resolved);
        expect(yield* makeClaudeEnvironment({ homePath: "" })).toBe(process.env);
      }),
    );

    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("keeps continuation compatible across instances with the same Claude HOME", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const resolved = path.resolve(NodeOS.homedir());

        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" })).toBe(
          `claude:home:${resolved}`,
        );
      }),
    );

    it.effect("derives default swap HOME from process HOME and realpaths it", () =>
      Effect.gen(function* () {
        const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-swap-home-"));
        try {
          const realHome = NodePath.join(tmp, "real-home");
          const linkedHome = NodePath.join(tmp, "linked-home");
          NodeFS.mkdirSync(realHome);
          NodeFS.symlinkSync(realHome, linkedHome);

          const osHome = NodePath.join(tmp, "os-home");
          const continuationKey = `claude:home:${osHome}`;
          const derived = yield* Effect.promise(() =>
            deriveClaudeSwapHomePath({
              continuationKey,
              env: { HOME: `${linkedHome}${NodePath.sep}` },
              osHomeDir: osHome,
            }),
          );

          expect(derived).toBe(NodeFS.realpathSync(realHome));
        } finally {
          NodeFS.rmSync(tmp, { recursive: true, force: true });
        }
      }),
    );

    it.effect(
      "derives default-instance projects dir with home semantics (~/.claude/projects)",
      () =>
        Effect.gen(function* () {
          const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-swap-projects-"));
          try {
            const osHome = NodePath.join(tmp, "os-home");
            NodeFS.mkdirSync(osHome);
            const projectsDir = yield* Effect.promise(() =>
              deriveClaudeSwapProjectsDir({
                continuationKey: `claude:home:${osHome}`,
                env: { HOME: osHome },
                osHomeDir: osHome,
              }),
            );
            expect(projectsDir).toBe(
              NodePath.join(NodeFS.realpathSync(osHome), ".claude", "projects"),
            );
          } finally {
            NodeFS.rmSync(tmp, { recursive: true, force: true });
          }
        }),
    );

    it.effect("derives custom-instance projects dir with CLAUDE_CONFIG_DIR semantics", () =>
      Effect.gen(function* () {
        // Since upstream #4017, a custom homePath is exported as
        // CLAUDE_CONFIG_DIR: the path IS the config dir, so the CLI writes
        // rollouts to <configDir>/projects — no ".claude" segment.
        const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-swap-configdir-"));
        try {
          const osHome = NodePath.join(tmp, "os-home");
          const configDir = NodePath.join(tmp, "work-claude-config");
          NodeFS.mkdirSync(osHome);
          NodeFS.mkdirSync(configDir);
          const projectsDir = yield* Effect.promise(() =>
            deriveClaudeSwapProjectsDir({
              continuationKey: `claude:home:${configDir}`,
              env: { HOME: osHome },
              osHomeDir: osHome,
            }),
          );
          expect(projectsDir).toBe(NodePath.join(NodeFS.realpathSync(configDir), "projects"));
        } finally {
          NodeFS.rmSync(tmp, { recursive: true, force: true });
        }
      }),
    );
  });
});
