// Boot-time ESM resolve hook for running t3code server/probes from source with
// plain `node` (Node >=24 native type-stripping).
//
// The repo convention is `.ts` relative import specifiers (tsconfig
// `rewriteRelativeImportExtensions`). A handful of files instead author `.js`
// specifiers pointing at sibling `.ts` files (e.g.
// packages/lhc-host/src/inference/claude-cli.ts -> "../shared/claude-bin.js").
// Node's native type-stripping does NOT remap `.js`->`.ts`, so those imports
// fail with ERR_MODULE_NOT_FOUND. This hook remaps a relative `.js` specifier
// to its `.ts` sibling when only the `.ts` exists. It is boot tooling only — it
// does not modify any package source.
//
// Usage: node --import ./packages/lhc-host/probes/ts-js-resolve-hook.mjs <entry.ts> ...
import * as NodeModule from "node:module";

NodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        const tsSpecifier = `${specifier.slice(0, -3)}.ts`;
        try {
          const resolved = nextResolve(tsSpecifier, context);
          return resolved;
        } catch {
          throw error;
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
