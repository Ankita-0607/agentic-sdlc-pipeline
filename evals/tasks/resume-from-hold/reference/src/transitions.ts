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

/**
 * The status a held sample was in immediately before it went on hold, or null
 * when the sample is not currently on hold.
 */
export function statusBeforeHold(sample: Sample): SampleStatus | null {
  if (currentStatus(sample) !== "on_hold") return null;
  return sample.events.at(-2)?.status ?? null;
}

/** Returns a copy of the sample with the new status appended to its history. */
export function applyTransition(sample: Sample, to: SampleStatus, at: string): Sample {
  const from = currentStatus(sample);
  // A held sample may only go back to where it came from, so it cannot skip a step.
  const allowed = from === "on_hold" ? to === statusBeforeHold(sample) : canTransition(from, to);
  if (!allowed) {
    throw new Error(`Cannot move sample ${sample.id} from ${from ?? "new"} to ${to}`);
  }
  const last = sample.events.at(-1);
  if (last && Date.parse(at) < Date.parse(last.at)) {
    throw new Error(`Sample ${sample.id}: event time ${at} is earlier than the previous event`);
  }
  return { ...sample, events: [...sample.events, { status: to, at }] };
}
