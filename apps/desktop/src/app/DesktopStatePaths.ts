import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

export const T3_DEFAULT_HOME_DIR_NAME = ".t3";

function normalizeConfiguredBaseDir(t3Home: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(t3Home)) {
    return Option.none();
  }
  const trimmed = t3Home.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

/**
 * Resolve the desktop state home. `t3Home` is the product's explicit override
 * (T3CODE_HOME for T3 Code, CCODE_LONG_HOME for CCode Long — the caller picks
 * which one it honours); `homeDirName` is the product's default directory
 * under `$HOME`.
 */
export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
  readonly homeDirName?: string;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
    input.joinPath(input.homeDirectory, input.homeDirName ?? T3_DEFAULT_HOME_DIR_NAME),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly t3Home: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.t3Home));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
