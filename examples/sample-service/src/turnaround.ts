import type { Sample, SampleStatus } from "./types.js";

const MS_PER_HOUR = 3_600_000;

/** The status the sample is in now, or null if it has no history yet. */
export function currentStatus(sample: Sample): SampleStatus | null {
  return sample.events.at(-1)?.status ?? null;
}

/**
 * Turnaround time in hours: from when the sample was received to when its
 * report was issued. Returns null for samples that have not been reported.
 */
export function turnaroundHours(sample: Sample): number | null {
  const received = sample.events.find((e) => e.status === "received");
  const reported = sample.events.find((e) => e.status === "reported");
  if (!received || !reported) return null;
  return (Date.parse(reported.at) - Date.parse(received.at)) / MS_PER_HOUR;
}
