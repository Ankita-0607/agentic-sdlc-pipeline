import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
import { findSlaBreaches } from "../src/sla.js";
import { sample } from "./fixtures.js";

const SLA = { routine: 72, stat: 24 };
const NOW = "2026-03-10T00:00:00Z";
const hoursBefore = (iso: string, hours: number) => new Date(Date.parse(iso) - hours * 3_600_000).toISOString();

describe("acceptance: SLA breaches", () => {
  it("flags an open sample that is past its SLA", () => {
    const open = sample("open-late", [["received", hoursBefore(NOW, 80)]]);
    expect(findSlaBreaches([open], NOW, SLA)).toEqual([
      { sampleId: "open-late", priority: "routine", elapsedHours: 80, slaHours: 72, state: "open" },
    ]);
  });

  it("flags a sample that was reported late, using its turnaround", () => {
    const late = sample(
      "stat-late",
      [
        ["received", "2026-03-01T00:00:00Z"],
        ["reported", "2026-03-02T06:00:00Z"],
      ],
      { priority: "stat" },
    );
    expect(findSlaBreaches([late], NOW, SLA)).toEqual([
      { sampleId: "stat-late", priority: "stat", elapsedHours: 30, slaHours: 24, state: "reported_late" },
    ]);
  });

  it("uses the SLA for the sample's own priority", () => {
    const received = hoursBefore(NOW, 30);
    const routine = sample("r", [["received", received]]);
    const stat = sample("s", [["received", received]], { priority: "stat" });
    expect(findSlaBreaches([routine, stat], NOW, SLA).map((b) => b.sampleId)).toEqual(["s"]);
  });

  it("does not flag a sample exactly at its SLA, on time, or never received", () => {
    const exact = sample("exact", [["received", hoursBefore(NOW, 72)]]);
    const onTime = sample("on-time", [
      ["received", "2026-03-01T00:00:00Z"],
      ["reported", "2026-03-03T00:00:00Z"],
    ]);
    const neverReceived = sample("ghost", []);
    expect(findSlaBreaches([exact, onTime, neverReceived], NOW, SLA)).toEqual([]);
  });

  it("orders breaches by elapsed hours, largest first", () => {
    const a = sample("a", [["received", hoursBefore(NOW, 100)]]);
    const b = sample("b", [["received", hoursBefore(NOW, 300)]]);
    const c = sample("c", [["received", hoursBefore(NOW, 200)]]);
    expect(findSlaBreaches([a, b, c], NOW, SLA).map((x) => x.sampleId)).toEqual(["b", "c", "a"]);
  });

  it("is exported from the package entry point", () => {
    expect(typeof (api as Record<string, unknown>).findSlaBreaches).toBe("function");
  });
});
