// Rollout fidelity certifier: compare a pre-compact Claude Code rollout
// against its post-swap rebuild through the canonical dump serializer.
// PASS = the rebuilt tail is an EXACT entry-suffix of the before-dump, with
// only [context · band] entries (and the trailing swap receipt) new.
//
//   node packages/lhc-host/scripts/certify-rollout-diff.mjs <before.jsonl> <after.jsonl>
//
// Runs on plain node >= 24 (type stripping); imports the same
// transcript-dump module the faithfulness-invariant tests lock down.

import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dumpClaudeRolloutLines, parseRolloutContent } from "../src/verify/transcript-dump.ts";

const [beforePath, afterPath] = process.argv.slice(2);
if (beforePath === undefined || afterPath === undefined) {
  console.error("usage: certify-rollout-diff.mjs <before.jsonl> <after.jsonl>");
  process.exit(2);
}

function dumpEntries(path) {
  const dump = dumpClaudeRolloutLines(parseRolloutContent(readFileSync(path, "utf8")));
  // Entries are label-line blocks separated by a blank line; bodies may
  // contain blank lines, so split on the label grammar, not on "\n\n".
  const labels =
    /^\[(user|assistant|assistant thinking|image|tool call · .*|tool result · .*|model change · .*|thinking level change · .*)\]$/;
  const lines = dump.split("\n");
  const entries = [];
  let current = null;
  for (const [index, line] of lines.entries()) {
    if (labels.test(line) && (index === 0 || lines[index - 1] === "")) {
      if (current !== null) entries.push(current.join("\n").replace(/\n+$/, ""));
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) entries.push(current.join("\n").replace(/\n+$/, ""));
  return { dump, entries };
}

const before = dumpEntries(beforePath);
const after = dumpEntries(afterPath);

const isBand = (entry) => entry.startsWith("[user]\n[context · ");
const isReceipt = (entry) =>
  entry.includes("[runtime note] session ") && entry.includes("resumed in-place");
const bands = after.entries.filter(isBand);
const tail = after.entries.filter((entry) => !isBand(entry) && !isReceipt(entry));

const beforeDumpPath = join(tmpdir(), "certify-before.txt");
const afterDumpPath = join(tmpdir(), "certify-after.txt");
writeFileSync(beforeDumpPath, before.dump);
writeFileSync(afterDumpPath, after.dump);

console.log(
  `before: ${before.entries.length} entries   after: ${after.entries.length} (bands=${bands.length}, tail=${tail.length})`,
);
console.log(`dumps written: ${beforeDumpPath} ${afterDumpPath}`);

if (tail.length === 0) {
  console.log("FAIL: rebuilt rollout has no tail entries");
  process.exit(1);
}
const anchors = before.entries
  .map((entry, index) => (entry === tail[0] ? index : -1))
  .filter((index) => index >= 0);
const exact = anchors.find(
  (index) =>
    before.entries.length - index === tail.length &&
    tail.every((entry, offset) => before.entries[index + offset] === entry),
);
if (exact !== undefined) {
  console.log(
    `PASS: exact suffix match — before[${exact}:${before.entries.length}] == rebuilt tail; ` +
      `${exact} entries compacted into ${bands.length} band(s)`,
  );
  process.exit(0);
}
console.log(`FAIL: tail is not an exact suffix (anchor candidates at ${JSON.stringify(anchors)})`);
for (const index of anchors) {
  const segment = before.entries.slice(index);
  const pairs = Math.min(segment.length, tail.length);
  for (let offset = 0; offset < pairs; offset += 1) {
    if (segment[offset] !== tail[offset]) {
      console.log(`  first mismatch vs anchor ${index} at tail[${offset}]:`);
      console.log(`    before: ${JSON.stringify(segment[offset]?.slice(0, 160))}`);
      console.log(`    after : ${JSON.stringify(tail[offset]?.slice(0, 160))}`);
      break;
    }
  }
  if (segment.length !== tail.length) {
    console.log(
      `  length mismatch vs anchor ${index}: before-tail=${segment.length} after-tail=${tail.length}`,
    );
  }
}
process.exit(1);
