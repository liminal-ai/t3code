// Fixture trimmer/analyzer for Slice 0.2 event-fidelity captures.
// Excluded from package checks because packages/lhc-host/tsconfig.json includes only src/.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface JsonLine {
  readonly lineNumber: number;
  readonly raw: string;
  readonly value: Record<string, unknown>;
}

function parseArgs(): {
  readonly provider: "claude" | "codex";
  readonly normalized: string;
  readonly rollout?: string;
  readonly outDir: string;
  readonly maxLines: number;
} {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=", 2);
    if (inlineValue !== undefined) {
      args.set(key, inlineValue);
      continue;
    }
    const next = process.argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    }
  }

  const provider = args.get("provider");
  const normalized = args.get("normalized");
  if ((provider !== "claude" && provider !== "codex") || !normalized) {
    throw new Error(
      "Usage: node packages/lhc-host/probes/trim-event-fidelity-fixtures.ts --provider claude|codex --normalized PATH [--rollout PATH] [--out-dir DIR]",
    );
  }
  return {
    provider,
    normalized,
    rollout: args.get("rollout"),
    outDir:
      args.get("out-dir") ??
      NodePath.join(process.cwd(), "packages/lhc-host/test/fixtures/event-fidelity", provider),
    maxLines: Number(args.get("max-lines") ?? "90"),
  };
}

function readJsonLines(filePath: string): JsonLine[] {
  return NodeFS.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, lineNumber: index + 1 }))
    .filter((line) => line.raw.trim().startsWith("{"))
    .map((line) => ({ ...line, value: JSON.parse(line.raw) }));
}

function stableString(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

function truncateLargeStrings(value: unknown, maxStringBytes = 1_200): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes <= maxStringBytes) return value;
    const head = value.slice(0, 700);
    const tail = value.slice(-300);
    return `${head}\n[...trimmed ${bytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8")} bytes...]\n${tail}`;
  }
  if (Array.isArray(value))
    return value.map((entry) => truncateLargeStrings(entry, maxStringBytes));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      truncateLargeStrings(entry, maxStringBytes),
    ]),
  );
}

function textLength(value: unknown): number {
  return typeof value === "string" ? Buffer.byteLength(value, "utf8") : 0;
}

function nestedGet(value: unknown, path: ReadonlyArray<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (current === null || current === undefined) return undefined;
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function summarizeNormalized(lines: JsonLine[]): Array<Record<string, unknown>> {
  const byItem = new Map<string, Record<string, unknown>>();
  const turnEvents = lines.filter(
    (line) =>
      line.value.type === "turn.started" ||
      line.value.type === "turn.completed" ||
      line.value.type === "turn.aborted",
  );

  for (const line of lines) {
    const itemId = typeof line.value.itemId === "string" ? line.value.itemId : undefined;
    if (!itemId) continue;
    const payload = line.value.payload as Record<string, unknown> | undefined;
    const itemType = typeof payload?.itemType === "string" ? payload.itemType : "unknown";
    const key = `${itemId}:${itemType}`;
    const current =
      byItem.get(key) ??
      ({
        itemId,
        itemType,
        eventLines: [],
        deltaBytesByKind: {},
        completedPayloadBytes: 0,
        completedLine: undefined,
      } as Record<string, unknown>);

    (current.eventLines as number[]).push(line.lineNumber);
    if (line.value.type === "content.delta") {
      const streamKind = String(payload?.streamKind ?? "unknown");
      const deltaBytes = textLength(payload?.delta);
      const deltaBytesByKind = current.deltaBytesByKind as Record<string, number>;
      deltaBytesByKind[streamKind] = (deltaBytesByKind[streamKind] ?? 0) + deltaBytes;
    }
    if (line.value.type === "item.completed") {
      current.completedLine = line.lineNumber;
      current.completedPayloadBytes = Buffer.byteLength(stableString(payload), "utf8");
      current.completedDetailBytes = textLength(payload?.detail);
      current.completedDataBytes = Buffer.byteLength(stableString(payload?.data), "utf8");
      current.rawPayloadBytes = Buffer.byteLength(
        stableString((line.value.raw as Record<string, unknown> | undefined)?.payload),
        "utf8",
      );
    }
    byItem.set(key, current);
  }

  return [
    {
      kind: "turns",
      lines: turnEvents.map((line) => ({
        line: line.lineNumber,
        type: line.value.type,
        turnId: line.value.turnId,
        payload: line.value.payload,
      })),
    },
    ...Array.from(byItem.values()),
  ];
}

function keepNormalizedLines(lines: JsonLine[], maxLines: number): Set<number> {
  const keep = new Set<number>();
  for (const line of lines) {
    if (
      line.value.type !== "content.delta" ||
      line.lineNumber <= 20 ||
      line.lineNumber > lines.length - 20
    ) {
      keep.add(line.lineNumber);
      continue;
    }
    const payload = line.value.payload as Record<string, unknown> | undefined;
    const delta = typeof payload?.delta === "string" ? payload.delta : "";
    if (!delta || delta.includes("1\n2\n3") || delta.includes("19998") || delta.length < 200) {
      keep.add(line.lineNumber);
    }
  }
  if (keep.size <= maxLines) return keep;

  const sorted = Array.from(keep).sort((a, b) => a - b);
  const head = sorted.slice(0, Math.floor(maxLines / 2));
  const tail = sorted.slice(-Math.ceil(maxLines / 2));
  return new Set([...head, ...tail]);
}

function writeTrimmedJsonl(input: {
  readonly lines: JsonLine[];
  readonly keep: Set<number>;
  readonly outputPath: string;
}): void {
  const output: string[] = [];
  let trimmed = 0;
  for (const line of input.lines) {
    if (input.keep.has(line.lineNumber)) {
      if (trimmed > 0) {
        output.push(JSON.stringify({ marker: `[...trimmed ${trimmed} lines...]` }));
        trimmed = 0;
      }
      output.push(JSON.stringify(truncateLargeStrings(line.value)));
    } else {
      trimmed += 1;
    }
  }
  if (trimmed > 0) {
    output.push(JSON.stringify({ marker: `[...trimmed ${trimmed} lines...]` }));
  }
  NodeFS.mkdirSync(NodePath.dirname(input.outputPath), { recursive: true });
  NodeFS.writeFileSync(input.outputPath, `${output.join("\n")}\n`);
}

function writeTrimmedText(inputPath: string, outputPath: string, maxLines: number): void {
  const lines = NodeFS.readFileSync(inputPath, "utf8").split(/\r?\n/);
  const keepIndexes = new Set<number>();
  lines.forEach((line, index) => {
    if (
      index < 30 ||
      index >= lines.length - 30 ||
      line.includes("turn") ||
      line.includes("item") ||
      line.includes("tool") ||
      line.includes("20000") ||
      line.includes("event-fidelity-small")
    ) {
      keepIndexes.add(index);
    }
  });
  const sorted = Array.from(keepIndexes).sort((a, b) => a - b);
  const capped =
    sorted.length > maxLines
      ? new Set([
          ...sorted.slice(0, Math.floor(maxLines / 2)),
          ...sorted.slice(-Math.ceil(maxLines / 2)),
        ])
      : keepIndexes;

  const output: string[] = [];
  let trimmed = 0;
  lines.forEach((line, index) => {
    if (capped.has(index)) {
      if (trimmed > 0) {
        output.push(`[...trimmed ${trimmed} lines...]`);
        trimmed = 0;
      }
      output.push(line);
    } else {
      trimmed += 1;
    }
  });
  if (trimmed > 0) output.push(`[...trimmed ${trimmed} lines...]`);
  NodeFS.writeFileSync(outputPath, `${output.join("\n")}\n`);
}

function main(): void {
  const args = parseArgs();
  const normalizedLines = readJsonLines(args.normalized);
  const summary = summarizeNormalized(normalizedLines);
  NodeFS.mkdirSync(args.outDir, { recursive: true });
  writeTrimmedJsonl({
    lines: normalizedLines,
    keep: keepNormalizedLines(normalizedLines, args.maxLines),
    outputPath: NodePath.join(args.outDir, `${args.provider}-normalized.jsonl`),
  });
  NodeFS.writeFileSync(
    NodePath.join(args.outDir, `${args.provider}-normalized-summary.json`),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  if (args.rollout) {
    const outputPath = NodePath.join(args.outDir, `${args.provider}-rollout-excerpt.jsonl`);
    writeTrimmedText(args.rollout, outputPath, args.maxLines);
  }

  const commandOutputDeltas = normalizedLines
    .filter((line) => {
      const payload = line.value.payload as Record<string, unknown> | undefined;
      return line.value.type === "content.delta" && payload?.streamKind === "command_output";
    })
    .reduce((sum, line) => sum + textLength(nestedGet(line.value, ["payload", "delta"])), 0);

  console.log(
    JSON.stringify(
      {
        provider: args.provider,
        normalizedLineCount: normalizedLines.length,
        commandOutputDeltaBytes: commandOutputDeltas,
        outputs: {
          normalized: NodePath.join(args.outDir, `${args.provider}-normalized.jsonl`),
          summary: NodePath.join(args.outDir, `${args.provider}-normalized-summary.json`),
          rollout: args.rollout
            ? NodePath.join(args.outDir, `${args.provider}-rollout-excerpt.jsonl`)
            : undefined,
        },
      },
      null,
      2,
    ),
  );
}

main();
