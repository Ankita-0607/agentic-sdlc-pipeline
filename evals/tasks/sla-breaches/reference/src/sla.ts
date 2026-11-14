import { turnaroundHours } from "./turnaround.js";
import type { Priority, Sample } from "./types.js";

const MS_PER_HOUR = 3_600_000;

export interface SlaBreach {
  sampleId: string;
  priority: Priority;
  elapsedHours: number;
  slaHours: number;
  state: "open" | "reported_late";
}

/** Samples whose turnaround, or time in the lab so far, is past the SLA for their priority. */
export function findSlaBreaches(samples: Sample[], now: string, slaHours: Record<Priority, number>): SlaBreach[] {
  const breaches: SlaBreach[] = [];
  for (const sample of samples) {
    const received = sample.events.find((e) => e.status === "received");
    if (!received) continue;

    const turnaround = turnaroundHours(sample);
    const elapsedHours = turnaround ?? (Date.parse(now) - Date.parse(received.at)) / MS_PER_HOUR;
    const limit = slaHours[sample.priority];
    if (elapsedHours > limit) {
      breaches.push({
        sampleId: sample.id,
        priority: sample.priority,
        elapsedHours,
        slaHours: limit,
        state: turnaround === null ? "open" : "reported_late",
      });
    }
  }
  return breaches.sort((a, b) => b.elapsedHours - a.elapsedHours);
}
