import type { Role } from "./types.js";

/** Default model for every role. Override per role in agent-policy.yaml (`models:`) or with ASDLC_MODEL. */
export const DEFAULT_MODEL = process.env.ASDLC_MODEL ?? "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Effort is the main cost/quality dial. Reading an issue and writing a spec is
 * cheap work; writing and reviewing code is where extra reasoning pays off.
 */
export const ROLE_EFFORT: Record<Role, Effort> = {
  spec: "medium",
  planner: "medium",
  implementer: "high",
  reviewer: "high",
};

/** Upper bound on one model response. Large enough for a full-file write. */
export const MAX_OUTPUT_TOKENS = 32_000;

/**
 * USD per million tokens. Used for the cost estimate in the run report and for
 * the budget guardrail; the provider invoice is the source of truth.
 * Cache writes are billed at 1.25x the input price (5-minute TTL).
 */
export const PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
};

export const CACHE_WRITE_MULTIPLIER = 1.25;
