import type { Priority, Sample, SampleStatus } from "../src/types.js";

/** Build a sample from [status, ISO timestamp] pairs. */
export function sample(
  id: string,
  events: Array<[SampleStatus, string]>,
  overrides: Partial<Pick<Sample, "clientId" | "assay" | "priority">> = {},
): Sample {
  return {
    id,
    clientId: overrides.clientId ?? "client-a",
    assay: overrides.assay ?? "exome",
    priority: (overrides.priority ?? "routine") as Priority,
    events: events.map(([status, at]) => ({ status, at })),
  };
}
