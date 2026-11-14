import { CACHE_WRITE_MULTIPLIER, PRICING } from "../config.js";
import type { Policy } from "../policy/policy.js";
import type { Role } from "../types.js";
import type { LlmUsage } from "./client.js";

export interface UsageTotals {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  /** Estimated USD. Calls on a model with no known price add nothing here. */
  cost_usd: number;
  unpriced_calls: number;
}

const zero = (): UsageTotals => ({
  calls: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0,
  unpriced_calls: 0,
});

export function estimateCostUsd(model: string, usage: LlmUsage): number | null {
  const price = PRICING[model];
  if (!price) return null;
  const perToken = 1 / 1_000_000;
  return (
    usage.input_tokens * price.input * perToken +
    usage.output_tokens * price.output * perToken +
    (usage.cache_read_input_tokens ?? 0) * price.cacheRead * perToken +
    (usage.cache_creation_input_tokens ?? 0) * price.input * CACHE_WRITE_MULTIPLIER * perToken
  );
}

export class BudgetExceededError extends Error {
  constructor(
    readonly limit: "max_cost_usd" | "max_total_tokens",
    message: string,
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

/** Accumulates token usage per agent role and enforces the policy budget. */
export class UsageTracker {
  private readonly byRole = new Map<Role, UsageTotals>();

  add(role: Role, model: string, usage: LlmUsage): void {
    const totals = this.byRole.get(role) ?? zero();
    totals.calls += 1;
    totals.input_tokens += usage.input_tokens;
    totals.output_tokens += usage.output_tokens;
    totals.cache_read_tokens += usage.cache_read_input_tokens ?? 0;
    totals.cache_write_tokens += usage.cache_creation_input_tokens ?? 0;
    const cost = estimateCostUsd(model, usage);
    if (cost === null) totals.unpriced_calls += 1;
    else totals.cost_usd += cost;
    this.byRole.set(role, totals);
  }

  forRole(role: Role): UsageTotals {
    return this.byRole.get(role) ?? zero();
  }

  total(): UsageTotals {
    const sum = zero();
    for (const t of this.byRole.values()) {
      sum.calls += t.calls;
      sum.input_tokens += t.input_tokens;
      sum.output_tokens += t.output_tokens;
      sum.cache_read_tokens += t.cache_read_tokens;
      sum.cache_write_tokens += t.cache_write_tokens;
      sum.cost_usd += t.cost_usd;
      sum.unpriced_calls += t.unpriced_calls;
    }
    return sum;
  }

  totalTokens(): number {
    const t = this.total();
    return t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
  }

  /** Called before every model call, so a runaway loop stops at the next turn. */
  assertWithinBudget(budget: Policy["budget"]): void {
    const total = this.total();
    if (total.cost_usd > budget.max_cost_usd) {
      throw new BudgetExceededError(
        "max_cost_usd",
        `estimated spend $${total.cost_usd.toFixed(2)} exceeds budget.max_cost_usd ($${budget.max_cost_usd})`,
      );
    }
    const tokens = this.totalTokens();
    if (tokens > budget.max_total_tokens) {
      throw new BudgetExceededError(
        "max_total_tokens",
        `${tokens} tokens used exceeds budget.max_total_tokens (${budget.max_total_tokens})`,
      );
    }
  }
}
