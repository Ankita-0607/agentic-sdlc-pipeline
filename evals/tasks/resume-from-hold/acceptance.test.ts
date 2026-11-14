import { describe, expect, it } from "vitest";
import { applyTransition, canTransition, statusBeforeHold } from "../src/transitions.js";
import { sample } from "./fixtures.js";

const heldFromSequencing = () =>
  sample("h1", [
    ["received", "2026-03-01T08:00:00Z"],
    ["sequencing", "2026-03-01T10:00:00Z"],
    ["on_hold", "2026-03-01T12:00:00Z"],
  ]);

describe("acceptance: resuming from hold", () => {
  it("reports the status a held sample came from", () => {
    expect(statusBeforeHold(heldFromSequencing())).toBe("sequencing");
  });

  it("returns null for a sample that is not on hold", () => {
    expect(statusBeforeHold(sample("s", [["received", "2026-03-01T08:00:00Z"]]))).toBeNull();
    expect(statusBeforeHold(sample("s", []))).toBeNull();
  });

  it("lets a held sample return to the status it was held from", () => {
    const resumed = applyTransition(heldFromSequencing(), "sequencing", "2026-03-01T18:00:00Z");
    expect(resumed.events.at(-1)).toEqual({ status: "sequencing", at: "2026-03-01T18:00:00Z" });
  });

  it.each(["received", "analysis", "review"] as const)("rejects resuming into %s instead", (target) => {
    expect(() => applyTransition(heldFromSequencing(), target, "2026-03-01T18:00:00Z")).toThrow(/^Cannot move sample h1/);
  });

  it("uses the most recent hold when a sample was held more than once", () => {
    let s = heldFromSequencing();
    s = applyTransition(s, "sequencing", "2026-03-01T18:00:00Z");
    s = applyTransition(s, "analysis", "2026-03-02T08:00:00Z");
    s = applyTransition(s, "on_hold", "2026-03-02T09:00:00Z");
    expect(statusBeforeHold(s)).toBe("analysis");
    expect(() => applyTransition(s, "sequencing", "2026-03-02T10:00:00Z")).toThrow(/^Cannot move sample/);
    expect(applyTransition(s, "analysis", "2026-03-02T10:00:00Z").events).toHaveLength(7);
  });

  it("leaves canTransition and ordinary transitions unchanged", () => {
    expect(canTransition("on_hold", "analysis")).toBe(true);
    expect(canTransition("received", "reported")).toBe(false);
    const s = sample("s", [["received", "2026-03-01T08:00:00Z"]]);
    expect(applyTransition(s, "sequencing", "2026-03-01T09:00:00Z").events).toHaveLength(2);
  });
});
