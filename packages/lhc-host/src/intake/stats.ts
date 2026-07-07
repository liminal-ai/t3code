import type { MessageEventInput } from "lhc";

export interface CaptureMapResult {
  events: MessageEventInput[];
  skips: Record<string, number>;
}

export interface CaptureStats {
  linesSeen: number;
  eventsOut: number;
  skips: Record<string, number>;
  malformed: number;
}

export function createCaptureStats(): CaptureStats {
  return { linesSeen: 0, eventsOut: 0, skips: {}, malformed: 0 };
}

export function incrementCounter(counters: Record<string, number>, key: string, amount = 1): void {
  counters[key] = (counters[key] ?? 0) + amount;
}

export function recordCaptureMapResult(stats: CaptureStats, result: CaptureMapResult): void {
  stats.linesSeen += 1;
  stats.eventsOut += result.events.length;
  for (const [key, count] of Object.entries(result.skips)) {
    incrementCounter(stats.skips, key, count);
  }
  stats.malformed += result.skips.malformed ?? 0;
}
