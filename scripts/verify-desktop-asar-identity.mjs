#!/usr/bin/env node

import { extractFile } from "@electron/asar";

const [asarPath, expectedName, expectedProductName] = process.argv.slice(2);
if (!asarPath || !expectedName || !expectedProductName) {
  console.error("Usage: verify-desktop-asar-identity.mjs <app.asar> <package-name> <product-name>");
  process.exit(2);
}

let manifest;
try {
  manifest = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
} catch (error) {
  console.error(`Unable to read packaged app identity from ${asarPath}:`, error);
  process.exit(1);
}

if (manifest.name !== expectedName || manifest.productName !== expectedProductName) {
  console.error(
    `Packaged app identity mismatch: name=${String(manifest.name)} productName=${String(manifest.productName)}`,
  );
  process.exit(1);
}

console.log(`app.asar identity: name=${manifest.name} productName=${manifest.productName}`);
