import { turnaroundHours } from "./turnaround.js";
import type { Sample } from "./types.js";

export interface ClientSummary {
  clientId: string;
  total: number;
  reported: number;
  /** Median turnaround of reported samples, or null when none are reported. */
  medianTatHours: number | null;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One summary row per client, ordered by client id. */
export function summarizeByClient(samples: Sample[]): ClientSummary[] {
  const byClient = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = byClient.get(sample.clientId) ?? [];
    list.push(sample);
    byClient.set(sample.clientId, list);
  }
  return [...byClient.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([clientId, list]) => {
      const tats = list.map(turnaroundHours).filter((t): t is number => t !== null);
      return { clientId, total: list.length, reported: tats.length, medianTatHours: median(tats) };
    });
}
