import type { Sample, SampleStatus } from "./types.js";

const MS_PER_HOUR = 3_600_000;

/** The status the sample is in now, or null if it has no history yet. */
export function currentStatus(sample: Sample): SampleStatus | null {
  return sample.events.at(-1)?.status ?? null;
}

/**
 * Turnaround time in hours: from when the sample was received to when its
 * report was issued, excluding any time spent on hold. Returns null for
 * samples that have not been reported.
 */
export function turnaroundHours(sample: Sample): number | null {
  const { events } = sample;
  const receivedAt = events.findIndex((e) => e.status === "received");
  const reportedAt = events.findIndex((e) => e.status === "reported");
  if (receivedAt === -1 || reportedAt === -1) return null;

  let ms = Date.parse(events[reportedAt]!.at) - Date.parse(events[receivedAt]!.at);
  for (let i = receivedAt; i < reportedAt; i++) {
    if (events[i]!.status === "on_hold") {
      ms -= Date.parse(events[i + 1]!.at) - Date.parse(events[i]!.at);
    }
  }
  return ms / MS_PER_HOUR;
}
