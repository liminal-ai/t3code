import { assert, describe, it } from "@effect/vitest";

import {
  isCCodeLongDesktopVersion,
  isDesktopUpdateChannelLocked,
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("recognises the CCode Long version discriminator without touching nightly", () => {
    const ccodeLong = "0.0.0-ccode-long.20260816.5";
    const nightly = "0.0.0-nightly.20260816.3";

    assert.isTrue(isCCodeLongDesktopVersion(ccodeLong));
    assert.isFalse(isNightlyDesktopVersion(ccodeLong));
    assert.isFalse(isCCodeLongDesktopVersion(nightly));
    assert.isTrue(isNightlyDesktopVersion(nightly));
    assert.isFalse(isCCodeLongDesktopVersion("1.2.3"));
    assert.isFalse(isCCodeLongDesktopVersion("1.2.3-ccode-long"));
  });

  it("resolves and locks the update channel per product", () => {
    assert.equal(resolveDefaultDesktopUpdateChannel("0.0.0-ccode-long.20260816.5"), "ccode-long");
    assert.equal(resolveDefaultDesktopUpdateChannel("0.0.0-nightly.20260816.3"), "nightly");
    assert.equal(resolveDefaultDesktopUpdateChannel("1.2.3"), "latest");
    assert.isTrue(isDesktopUpdateChannelLocked("0.0.0-ccode-long.20260816.5"));
    assert.isFalse(isDesktopUpdateChannelLocked("0.0.0-nightly.20260816.3"));
    assert.isFalse(isDesktopUpdateChannelLocked("1.2.3"));
  });
});
