import { currentStatus } from "./turnaround.js";
import type { Sample, SampleStatus } from "./types.js";

const ALLOWED: Record<SampleStatus, readonly SampleStatus[]> = {
  received: ["sequencing", "on_hold"],
  sequencing: ["analysis", "on_hold"],
  analysis: ["review", "on_hold"],
  review: ["reported", "analysis", "on_hold"],
  reported: [],
  on_hold: ["received", "sequencing", "analysis", "review"],
};

/** Whether a sample in status `from` may move to status `to`. A new sample (null) can only be received. */
export function canTransition(from: SampleStatus | null, to: SampleStatus): boolean {
  if (from === null) return to === "received";
  return ALLOWED[from].includes(to);
}

/** Returns a copy of the sample with the new status appended to its history. */
export function applyTransition(sample: Sample, to: SampleStatus, at: string): Sample {
  const from = currentStatus(sample);
  if (!canTransition(from, to)) {
    throw new Error(`Cannot move sample ${sample.id} from ${from ?? "new"} to ${to}`);
  }
  const last = sample.events.at(-1);
  if (last && Date.parse(at) < Date.parse(last.at)) {
    throw new Error(`Sample ${sample.id}: event time ${at} is earlier than the previous event`);
  }
  return { ...sample, events: [...sample.events, { status: to, at }] };
}
