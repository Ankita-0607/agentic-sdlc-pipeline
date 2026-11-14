import { describe, expect, it } from "vitest";
import { turnaroundHours } from "../src/turnaround.js";
import { sample } from "./fixtures.js";

describe("turnaroundHours with holds", () => {
  it("does not count time on hold", () => {
    const s = sample("s1", [
      ["received", "2026-03-01T08:00:00Z"],
      ["on_hold", "2026-03-01T12:00:00Z"],
      ["sequencing", "2026-03-01T18:00:00Z"],
      ["reported", "2026-03-03T08:00:00Z"],
    ]);
    expect(turnaroundHours(s)).toBe(42);
  });
});
