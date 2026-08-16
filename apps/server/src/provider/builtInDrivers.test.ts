import { assert, it } from "@effect/vitest";

import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";

it("registers only the Claude driver", () => {
  assert.deepStrictEqual(
    BUILT_IN_DRIVERS.map((driver) => driver.driverKind),
    ["claudeAgent"],
  );
});
