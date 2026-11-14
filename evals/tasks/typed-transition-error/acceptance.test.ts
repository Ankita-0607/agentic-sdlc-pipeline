import { describe, expect, it } from "vitest";
import { applyTransition, InvalidTransitionError } from "../src/transitions.js";
import { sample } from "./fixtures.js";

function capture(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to throw");
}

describe("acceptance: typed transition error", () => {
  it("throws InvalidTransitionError with the sample id and both statuses", () => {
    const s = sample("s-42", [["received", "2026-03-01T08:00:00Z"]]);
    const err = capture(() => applyTransition(s, "reported", "2026-03-01T09:00:00Z"));
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: "InvalidTransitionError", sampleId: "s-42", from: "received", to: "reported" });
  });

  it("keeps the existing message format", () => {
    const s = sample("s-42", [["received", "2026-03-01T08:00:00Z"]]);
    const err = capture(() => applyTransition(s, "reported", "2026-03-01T09:00:00Z")) as Error;
    expect(err.message).toBe("Cannot move sample s-42 from received to reported");
  });

  it("reports from as null for a sample with no history", () => {
    const err = capture(() => applyTransition(sample("new-1", []), "sequencing", "2026-03-01T09:00:00Z")) as Error;
    expect(err).toBeInstanceOf(InvalidTransitionError);
    expect(err).toMatchObject({ from: null, to: "sequencing" });
    expect(err.message).toBe("Cannot move sample new-1 from new to sequencing");
  });

  it("keeps an out-of-order timestamp as a plain Error", () => {
    const s = sample("s-1", [["received", "2026-03-01T08:00:00Z"]]);
    const err = capture(() => applyTransition(s, "sequencing", "2026-03-01T07:00:00Z"));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(InvalidTransitionError);
  });

  it("still applies valid transitions", () => {
    const s = sample("s-1", [["received", "2026-03-01T08:00:00Z"]]);
    expect(applyTransition(s, "sequencing", "2026-03-01T09:00:00Z").events).toHaveLength(2);
  });
});
