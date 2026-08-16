/**
 * CCode Long desktop identity: the one place the Claude-focused desktop
 * product's names, ids, scheme, paths, and update channel are defined.
 *
 * Both the desktop packager (scripts/build-desktop-artifact.ts) and the
 * Electron runtime (apps/desktop) read from here, so Info.plist and runtime
 * identity cannot drift apart. Upstream T3 Code stable/nightly/dev identity is
 * untouched and still lives where it always did; this module only describes
 * the CCode Long variant and how a build is recognised as one.
 *
 * A build is a CCode Long build when its version carries the CCode Long
 * prerelease discriminator (`0.0.0-ccode-long.20260816.5`). The same version
 * string is what electron-builder stamps into the bundle and what
 * `app.getVersion()` returns, so build and runtime agree by construction.
 */

export const CCODE_LONG_VERSION_DISCRIMINATOR = "ccode-long";

const CCODE_LONG_VERSION_PATTERN = new RegExp(
  `-${CCODE_LONG_VERSION_DISCRIMINATOR}\\.\\d{8}\\.\\d+$`,
);

export function isCCodeLongDesktopVersion(version: string): boolean {
  return CCODE_LONG_VERSION_PATTERN.test(version);
}

export const CCODE_LONG_DESKTOP_IDENTITY = {
  /** Display and product name; also `app.setName`, so the Safe Storage keychain
   *  item is "CCode Long Safe Storage". */
  productName: "CCode Long",
  /** macOS bundle identifier and Windows AppUserModelId. */
  appId: "ai.liminal.ccodelong",
  /** Deep-link URL scheme and the privileged renderer scheme (`ccode-long://app/`). */
  scheme: "ccode-long",
  /** Linux executable name, WM class, and desktop entry stem. */
  executableName: "ccode-long",
  /** electron-builder artifact prefix (`CCode-Long-<version>-<arch>.<ext>`). */
  artifactPrefix: "CCode-Long",
  /** electron-updater channel; the feed file is `ccode-long-mac.yml`. */
  updateChannel: "ccode-long",
  /** Electron userData directory name under the platform app-data root. */
  userDataDirName: "ccode-long",
  /** Default state home directory name under `$HOME` (server db, settings, logs). */
  homeDirName: ".ccode-long",
  /** Explicit state home override. `T3CODE_HOME` is never honoured for this product. */
  homeEnvVar: "CCODE_LONG_HOME",
} as const;

export type CCodeLongDesktopIdentity = typeof CCODE_LONG_DESKTOP_IDENTITY;
