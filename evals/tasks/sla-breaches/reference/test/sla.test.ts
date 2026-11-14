import { describe, expect, it } from "vitest";
import { findSlaBreaches } from "../src/sla.js";
import { sample } from "./fixtures.js";

const SLA = { routine: 72, stat: 24 };

describe("findSlaBreaches", () => {
  it("flags open samples past the SLA and ignores those within it", () => {
    const late = sample("late", [["received", "2026-03-01T00:00:00Z"]]);
    const fresh = sample("fresh", [["received", "2026-03-04T12:00:00Z"]]);
    const breaches = findSlaBreaches([late, fresh], "2026-03-05T00:00:00Z", SLA);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ sampleId: "late", elapsedHours: 96, state: "open" });
  });

  it("flags samples reported after the SLA", () => {
    const s = sample("s", [
      ["received", "2026-03-01T00:00:00Z"],
      ["reported", "2026-03-05T00:00:00Z"],
    ]);
    expect(findSlaBreaches([s], "2026-03-09T00:00:00Z", SLA)[0]).toMatchObject({ state: "reported_late", elapsedHours: 96 });
  });
});
