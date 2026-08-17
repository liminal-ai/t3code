/**
 * Desktop build identity resolvers: the values the packager writes into
 * Info.plist (CFBundleIdentifier, CFBundleName, CFBundleURLSchemes), the
 * artifact name, and the updater channel, all keyed on the build version.
 *
 * Kept in scripts/lib so apps/desktop tests can import it and cross-check the
 * bundle-declared identity against the runtime identity. Upstream T3 Code
 * stable/nightly values are unchanged; CCode Long values come from the shared
 * identity source.
 */
import {
  CCODE_LONG_DESKTOP_IDENTITY,
  isCCodeLongDesktopVersion,
} from "@t3tools/shared/desktopProductIdentity";
import desktopPackageJson from "../../apps/desktop/package.json" with { type: "json" };

const DESKTOP_APP_ID = "com.t3tools.t3code";
const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export type DesktopBuildUpdateChannel = "latest" | "nightly" | "ccode-long";

/**
 * electron-updater channel for a build version. CCode Long has its own channel
 * (feed file `ccode-long-mac.yml`) so it never shares a feed with T3 Code.
 */
export function resolveDesktopUpdateChannel(version: string): DesktopBuildUpdateChannel {
  if (isCCodeLongDesktopVersion(version)) return CCODE_LONG_DESKTOP_IDENTITY.updateChannel;
  return NIGHTLY_VERSION_PATTERN.test(version) ? "nightly" : "latest";
}

/**
 * Artwork (icons, DMG chrome, web brand) is still keyed on the two upstream
 * looks. CCode Long uses the neutral production artwork until it has its own.
 */
export function resolveDesktopArtworkChannel(version: string): "latest" | "nightly" {
  return resolveDesktopUpdateChannel(version) === "nightly" ? "nightly" : "latest";
}

export function resolveDesktopProductName(version: string): string {
  if (isCCodeLongDesktopVersion(version)) return CCODE_LONG_DESKTOP_IDENTITY.productName;
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "T3 Code (Nightly)"
    : (desktopPackageJson.productName ?? "T3 Code");
}

export function resolveDesktopAppId(version: string): string {
  if (isCCodeLongDesktopVersion(version)) return CCODE_LONG_DESKTOP_IDENTITY.appId;
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? `${DESKTOP_APP_ID}.nightly`
    : DESKTOP_APP_ID;
}

export function resolveDesktopExecutableName(version: string): string {
  if (isCCodeLongDesktopVersion(version)) return CCODE_LONG_DESKTOP_IDENTITY.executableName;
  return resolveDesktopUpdateChannel(version) === "nightly" ? "t3code-nightly" : "t3code";
}

/**
 * The package name embedded in app.asar. Electron can use this value when it
 * chooses the macOS Safe Storage keychain service, so it must not retain the
 * upstream package identity in a CCode Long build.
 */
export function resolveDesktopPackageName(version: string): string {
  return isCCodeLongDesktopVersion(version) ? CCODE_LONG_DESKTOP_IDENTITY.executableName : "t3code";
}

export function resolveDesktopProtocols(version: string): readonly string[] {
  if (isCCodeLongDesktopVersion(version)) return [CCODE_LONG_DESKTOP_IDENTITY.scheme];
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? ["t3code-nightly"]
    : ["t3code", "t3code-dev"];
}

export function resolveDesktopArtifactNameTemplate(version: string): string {
  if (isCCodeLongDesktopVersion(version)) {
    return `${CCODE_LONG_DESKTOP_IDENTITY.artifactPrefix}-\${version}-\${arch}.\${ext}`;
  }
  return resolveDesktopUpdateChannel(version) === "nightly"
    ? "T3-Code-Nightly-${version}-${arch}.${ext}"
    : "T3-Code-${version}-${arch}.${ext}";
}
