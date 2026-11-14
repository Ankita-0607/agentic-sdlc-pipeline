import { describe, expect, it } from "vitest";
import { turnaroundHours } from "../src/turnaround.js";
import { sample } from "./fixtures.js";

describe("acceptance: turnaround excludes time on hold", () => {
  it("subtracts a single hold", () => {
    const s = sample("a1", [
      ["received", "2026-03-01T08:00:00Z"],
      ["on_hold", "2026-03-01T12:00:00Z"],
      ["sequencing", "2026-03-01T18:00:00Z"],
      ["analysis", "2026-03-02T08:00:00Z"],
      ["review", "2026-03-02T20:00:00Z"],
      ["reported", "2026-03-03T08:00:00Z"],
    ]);
    expect(turnaroundHours(s)).toBe(42);
  });

  it("subtracts every hold when there are several", () => {
    const s = sample("a2", [
      ["received", "2026-03-01T00:00:00Z"],
      ["on_hold", "2026-03-01T02:00:00Z"],
      ["received", "2026-03-01T05:00:00Z"],
      ["sequencing", "2026-03-01T10:00:00Z"],
      ["on_hold", "2026-03-01T12:00:00Z"],
      ["sequencing", "2026-03-01T22:00:00Z"],
      ["analysis", "2026-03-02T00:00:00Z"],
      ["review", "2026-03-02T06:00:00Z"],
      ["reported", "2026-03-02T12:00:00Z"],
    ]);
    // 36 hours wall clock, minus 3 hours and 10 hours on hold.
    expect(turnaroundHours(s)).toBe(23);
  });

  it("leaves samples without holds unchanged", () => {
    const s = sample("a3", [
      ["received", "2026-03-01T08:00:00Z"],
      ["sequencing", "2026-03-01T12:00:00Z"],
      ["analysis", "2026-03-02T08:00:00Z"],
      ["review", "2026-03-02T20:00:00Z"],
      ["reported", "2026-03-03T08:00:00Z"],
    ]);
    expect(turnaroundHours(s)).toBe(48);
  });

  it("still returns null for a sample that is on hold and not reported", () => {
    const s = sample("a4", [
      ["received", "2026-03-01T08:00:00Z"],
      ["on_hold", "2026-03-01T12:00:00Z"],
    ]);
    expect(turnaroundHours(s)).toBeNull();
  });
});
