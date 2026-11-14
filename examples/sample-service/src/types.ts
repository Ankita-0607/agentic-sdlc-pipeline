/** A laboratory sample moving through a sequencing and reporting workflow. */

export type SampleStatus = "received" | "sequencing" | "analysis" | "review" | "reported" | "on_hold";

export type Priority = "routine" | "stat";

export interface StatusEvent {
  status: SampleStatus;
  /** ISO 8601 timestamp of when the sample entered this status. */
  at: string;
}

export interface Sample {
  id: string;
  clientId: string;
  assay: string;
  priority: Priority;
  /** Status history, oldest first. */
  events: StatusEvent[];
}
