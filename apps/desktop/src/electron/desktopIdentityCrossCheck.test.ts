import { assert, describe, it } from "@effect/vitest";
import { CCODE_LONG_DESKTOP_IDENTITY } from "@t3tools/shared/desktopProductIdentity";

import { getDesktopScheme } from "./ElectronProtocol.ts";
import { isCCodeLongDesktopVersion, isNightlyDesktopVersion } from "../updates/updateChannels.ts";
// The packager's resolvers are the source of the Info.plist values
// (CFBundleIdentifier, CFBundleURLSchemes, product name). Import them directly
// so a build/runtime identity split fails here instead of on a user's Mac.
import {
  resolveDesktopAppId,
  resolveDesktopProductName,
  resolveDesktopProtocols,
} from "../../../../scripts/lib/desktop-identity.ts";

/** Mirrors DesktopEnvironment's runtime scheme selection for a packaged build. */
function runtimeSchemeFor(version: string): string {
  const isCCodeLong = isCCodeLongDesktopVersion(version);
  const isNightly = !isCCodeLong && isNightlyDesktopVersion(version);
  return getDesktopScheme(false, isNightly, isCCodeLong);
}

describe("desktop identity: Info.plist vs runtime", () => {
  it("registers exactly the URL scheme the bundle declares, per version", () => {
    for (const version of ["0.0.0-ccode-long.20260816.5", "0.0.0-nightly.20260816.3", "1.2.3"]) {
      const declared = resolveDesktopProtocols(version);
      assert.include(declared, runtimeSchemeFor(version), version);
    }
  });

  it("keeps CCode Long bundle identity aligned with the shared identity source", () => {
    const version = "0.0.0-ccode-long.20260816.5";
    assert.equal(resolveDesktopAppId(version), CCODE_LONG_DESKTOP_IDENTITY.appId);
    assert.equal(resolveDesktopProductName(version), CCODE_LONG_DESKTOP_IDENTITY.productName);
    assert.deepStrictEqual(resolveDesktopProtocols(version), [CCODE_LONG_DESKTOP_IDENTITY.scheme]);
    assert.equal(runtimeSchemeFor(version), CCODE_LONG_DESKTOP_IDENTITY.scheme);
  });
});
