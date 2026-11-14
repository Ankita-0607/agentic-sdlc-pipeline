import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeState, encodeState, readIssueFile } from "../src/github.js";
import { estimateCostUsd, UsageTracker } from "../src/llm/usage.js";
import type { PlanState } from "../src/types.js";
import { PLAN, SPEC, tempDir } from "./helpers.js";

const STATE: PlanState = {
  run_id: "run-1",
  issue: { source: "o/r#3", number: 3, title: "T", body: "B with <!-- html --> and ünïcode" },
  spec: SPEC,
  plan: PLAN,
  plan_policy_warnings: [],
  base_commit: "abc123",
};

describe("plan state carried in an issue comment", () => {
  it("round-trips through the hidden marker", () => {
    const comment = `## Proposed plan\n\nsome markdown\n${encodeState(STATE)}`;
    expect(decodeState(comment)).toEqual(STATE);
  });

  it("returns null for comments without state, with corrupt state, or with the wrong shape", () => {
    expect(decodeState("/approve")).toBeNull();
    expect(decodeState("<!-- asdlc:plan-state:!!!notbase64 -->")).toBeNull();
    const wrongShape = Buffer.from(JSON.stringify({ run_id: "x" })).toString("base64");
    expect(decodeState(`<!-- asdlc:plan-state:${wrongShape} -->`)).toBeNull();
  });
});

describe("issue files", () => {
  it("uses the first heading as the title and the rest as the body", () => {
    const file = path.join(tempDir(), "issue.md");
    fs.writeFileSync(file, "# Add a thing\n\nBecause reasons.\n");
    expect(readIssueFile(file)).toEqual({ source: file, title: "Add a thing", body: "Because reasons." });
  });
});

describe("cost accounting", () => {
  it("prices input, output, cache reads and cache writes separately", () => {
    const cost = estimateCostUsd("claude-opus-5-5", {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(4 + 20 + 0.2 + 5, 6);
  });

  it("does not invent a price for an unknown model", () => {
    expect(estimateCostUsd("some-future-model", { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeNull();
    const tracker = new UsageTracker();
    tracker.add("spec", "some-future-model", { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null, cache_creation_input_tokens: null });
    expect(tracker.total()).toMatchObject({ calls: 1, cost_usd: 0, unpriced_calls: 1 });
    expect(tracker.totalTokens()).toBe(15);
  });
});
