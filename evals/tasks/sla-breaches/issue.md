# Flag samples that have breached their turnaround SLA

Operations wants a daily list of samples that are past their turnaround SLA so
the lab leads can chase them. Routine and STAT samples have different SLAs.

## What we need

A new module `src/sla.ts`, re-exported from `src/index.ts`, with:

```ts
export interface SlaBreach {
  sampleId: string;
  priority: Priority;
  elapsedHours: number;
  slaHours: number;
  state: "open" | "reported_late";
}

export function findSlaBreaches(
  samples: Sample[],
  now: string, // ISO 8601
  slaHours: Record<Priority, number>,
): SlaBreach[];
```

Rules:

- A **reported** sample is a breach when its turnaround (`turnaroundHours`) is
  greater than the SLA for its priority. Its `state` is `"reported_late"` and
  `elapsedHours` is the turnaround.
- An **unreported** sample that has a `received` event is a breach when the
  hours from `received` to `now` are greater than the SLA. Its `state` is
  `"open"` and `elapsedHours` is that elapsed time.
- Exactly at the SLA is not a breach.
- Samples with no `received` event are ignored.
- The result is ordered by `elapsedHours`, largest first.
