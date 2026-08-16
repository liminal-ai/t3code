import type { DesktopUpdateChannel } from "@t3tools/contracts";
import {
  CCODE_LONG_DESKTOP_IDENTITY,
  isCCodeLongDesktopVersion,
} from "@t3tools/shared/desktopProductIdentity";

const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

export { isCCodeLongDesktopVersion };

/**
 * A CCode Long build is pinned to its own update channel: it must never be
 * switched onto the T3 Code `latest`/`nightly` feeds, which live in the same
 * release repository and would otherwise be offered as "updates".
 */
export function isDesktopUpdateChannelLocked(appVersion: string): boolean {
  return isCCodeLongDesktopVersion(appVersion);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  if (isCCodeLongDesktopVersion(appVersion)) {
    return CCODE_LONG_DESKTOP_IDENTITY.updateChannel;
  }
  return isNightlyDesktopVersion(appVersion) ? "nightly" : "latest";
}
