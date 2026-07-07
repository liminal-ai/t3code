import { describe, expect, it } from "vite-plus/test";

import { isAutoCompactSuppressionEnabled } from "./flags.js";

describe("isAutoCompactSuppressionEnabled", () => {
  it("defaults on when LHC capture is active", () => {
    expect(isAutoCompactSuppressionEnabled({})).toBe(true);
  });

  it("is forced off when capture is disabled", () => {
    expect(
      isAutoCompactSuppressionEnabled({
        T3CODE_LHC_DISABLE: "1",
      }),
    ).toBe(false);
    expect(
      isAutoCompactSuppressionEnabled({
        T3CODE_LHC_DISABLE: "1",
        T3CODE_LHC_SUPPRESS_AUTOCOMPACT: "1",
      }),
    ).toBe(false);
  });

  it("can be opted out with T3CODE_LHC_SUPPRESS_AUTOCOMPACT=0|false", () => {
    expect(
      isAutoCompactSuppressionEnabled({
        T3CODE_LHC_SUPPRESS_AUTOCOMPACT: "0",
      }),
    ).toBe(false);
    expect(
      isAutoCompactSuppressionEnabled({
        T3CODE_LHC_SUPPRESS_AUTOCOMPACT: "false",
      }),
    ).toBe(false);
  });
});
