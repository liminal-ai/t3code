#!/usr/bin/env node --experimental-strip-types
// @effect-diagnostics globalConsole:off
import { formatScenarioSummary, runConcurrencyScenario } from "./load-harness.ts";

const summary = await runConcurrencyScenario({
  name: process.env.LHC_LOAD_NAME ?? "standalone-load",
  realInference: process.env.LHC_LOAD_REAL_INFERENCE === "1",
});

console.log(formatScenarioSummary(summary));
