import { describe, expect, it } from "vitest";
import { applyTransition, InvalidTransitionError } from "../src/transitions.js";
import { sample } from "./fixtures.js";

describe("InvalidTransitionError", () => {
  it("carries the sample id and the statuses", () => {
    const s = sample("s1", [["received", "2026-03-01T08:00:00Z"]]);
    try {
      applyTransition(s, "reported", "2026-03-01T09:00:00Z");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect(err).toMatchObject({ sampleId: "s1", from: "received", to: "reported" });
    }
  });

  it("is not used for out-of-order timestamps", () => {
    const s = sample("s1", [["received", "2026-03-01T08:00:00Z"]]);
    expect(() => applyTransition(s, "sequencing", "2026-03-01T07:00:00Z")).not.toThrow(InvalidTransitionError);
    expect(() => applyTransition(s, "sequencing", "2026-03-01T07:00:00Z")).toThrow(/earlier/);
  });
});
