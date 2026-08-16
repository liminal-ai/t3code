import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_LINUX_PASSWORD_STORE,
  normalizeLinuxPasswordStorePreference,
  resolveLinuxPasswordStoreSwitch,
  type LinuxPasswordStoreSwitch,
  type LinuxPasswordStorePreference,
} from "../linuxSecretStorage.ts";
import {
  resolveDesktopBaseDir,
  resolveDesktopStateDir,
  type JoinPath,
} from "./DesktopStatePaths.ts";
import { isNightlyDesktopVersion } from "../updates/updateChannels.ts";

interface EarlyDesktopSettingsInput {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly readFileString: (path: string) => string;
  readonly appVersion?: string;
}

type EarlyLinuxElectronOptionsInput = EarlyDesktopSettingsInput;

export interface EarlyLinuxElectronOptions {
  readonly linuxWmClass: string;
  readonly passwordStore: LinuxPasswordStoreSwitch | null;
}

const trimNonEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const EarlyDesktopSettingsJson = fromLenientJson(
  Schema.Struct({
    linuxPasswordStore: Schema.optionalKey(Schema.Unknown),
  }),
);
const decodeEarlyDesktopSettingsJson = Schema.decodeSync(EarlyDesktopSettingsJson);

const isDevelopmentEnvironment = (env: NodeJS.ProcessEnv): boolean =>
  trimNonEmpty(env.VITE_DEV_SERVER_URL) !== null;

const isNightlyEnvironment = (input: {
  readonly env: NodeJS.ProcessEnv;
  readonly appVersion?: string;
}): boolean =>
  !isDevelopmentEnvironment(input.env) &&
  input.appVersion !== undefined &&
  isNightlyDesktopVersion(input.appVersion);

function resolveEarlyDesktopSettingsPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly appVersion?: string;
}): string {
  const t3Home = Option.fromUndefinedOr(input.env.T3CODE_HOME);
  const resolvedBaseDir = resolveDesktopBaseDir({
    homeDirectory: input.homeDirectory,
    joinPath: input.joinPath,
    t3Home,
  });
  const baseDir =
    isNightlyEnvironment(input) && trimNonEmpty(input.env.T3CODE_HOME) === null
      ? input.joinPath(resolvedBaseDir, "nightly")
      : resolvedBaseDir;
  const stateDir = resolveDesktopStateDir({
    baseDir,
    isDevelopment: isDevelopmentEnvironment(input.env),
    joinPath: input.joinPath,
    t3Home,
  });
  return input.joinPath(stateDir, "desktop-settings.json");
}

export function resolveEarlyLinuxPasswordStorePreference(
  input: EarlyDesktopSettingsInput,
): LinuxPasswordStorePreference {
  const settingsPath = resolveEarlyDesktopSettingsPath(input);
  try {
    const parsed = decodeEarlyDesktopSettingsJson(input.readFileString(settingsPath));
    return normalizeLinuxPasswordStorePreference(parsed.linuxPasswordStore);
  } catch {
    return DEFAULT_LINUX_PASSWORD_STORE;
  }
}

export function resolveEarlyLinuxElectronOptions(
  input: EarlyLinuxElectronOptionsInput,
): EarlyLinuxElectronOptions {
  const preference = resolveEarlyLinuxPasswordStorePreference(input);
  return {
    linuxWmClass: isDevelopmentEnvironment(input.env)
      ? "t3code-dev"
      : isNightlyEnvironment(input)
        ? "t3code-nightly"
        : "t3code",
    passwordStore: resolveLinuxPasswordStoreSwitch({
      preference,
      env: input.env,
    }),
  };
}
