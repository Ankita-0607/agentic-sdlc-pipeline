import { describe, expect, it } from "vitest";
import { applyTransition, canTransition } from "../src/transitions.js";
import { sample } from "./fixtures.js";

describe("canTransition", () => {
  it("allows the normal forward path", () => {
    expect(canTransition(null, "received")).toBe(true);
    expect(canTransition("received", "sequencing")).toBe(true);
    expect(canTransition("review", "reported")).toBe(true);
  });

  it("rejects skipping steps and leaving a terminal status", () => {
    expect(canTransition("received", "reported")).toBe(false);
    expect(canTransition("reported", "analysis")).toBe(false);
    expect(canTransition(null, "sequencing")).toBe(false);
  });
});

describe("applyTransition", () => {
  it("appends the event without mutating the original", () => {
    const before = sample("s1", [["received", "2026-03-01T08:00:00Z"]]);
    const after = applyTransition(before, "sequencing", "2026-03-01T12:00:00Z");
    expect(after.events).toHaveLength(2);
    expect(before.events).toHaveLength(1);
  });

  it("throws on a transition that is not allowed", () => {
    const s = sample("s1", [["received", "2026-03-01T08:00:00Z"]]);
    expect(() => applyTransition(s, "reported", "2026-03-01T09:00:00Z")).toThrow(/Cannot move sample s1/);
  });

  it("throws when the event is earlier than the previous one", () => {
    const s = sample("s1", [["received", "2026-03-01T08:00:00Z"]]);
    expect(() => applyTransition(s, "sequencing", "2026-03-01T07:00:00Z")).toThrow(/earlier/);
  });

  it("lets a held sample resume", () => {
    let s = sample("s1", [["received", "2026-03-01T08:00:00Z"]]);
    s = applyTransition(s, "on_hold", "2026-03-01T09:00:00Z");
    s = applyTransition(s, "sequencing", "2026-03-01T15:00:00Z");
    expect(s.events.at(-1)?.status).toBe("sequencing");
  });
});
