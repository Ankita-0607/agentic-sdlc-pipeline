import { describe, expect, it } from "vitest";
import { currentStatus, turnaroundHours } from "../src/turnaround.js";
import { sample } from "./fixtures.js";

describe("currentStatus", () => {
  it("is null for a sample with no history", () => {
    expect(currentStatus(sample("s1", []))).toBeNull();
  });

  it("is the most recent status", () => {
    const s = sample("s1", [
      ["received", "2026-03-01T08:00:00Z"],
      ["sequencing", "2026-03-01T12:00:00Z"],
    ]);
    expect(currentStatus(s)).toBe("sequencing");
  });
});

describe("turnaroundHours", () => {
  it("measures received to reported", () => {
    const s = sample("s1", [
      ["received", "2026-03-01T08:00:00Z"],
      ["sequencing", "2026-03-01T12:00:00Z"],
      ["analysis", "2026-03-02T08:00:00Z"],
      ["review", "2026-03-02T20:00:00Z"],
      ["reported", "2026-03-03T08:00:00Z"],
    ]);
    expect(turnaroundHours(s)).toBe(48);
  });

  it("is null until the sample is reported", () => {
    const s = sample("s1", [["received", "2026-03-01T08:00:00Z"]]);
    expect(turnaroundHours(s)).toBeNull();
  });
});
