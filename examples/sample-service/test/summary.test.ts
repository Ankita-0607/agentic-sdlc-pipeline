import { describe, expect, it } from "vitest";
import { summarizeByClient } from "../src/summary.js";
import { sample } from "./fixtures.js";

const reportedAfter = (id: string, hours: number, clientId: string) =>
  sample(
    id,
    [
      ["received", "2026-03-01T00:00:00Z"],
      ["reported", new Date(Date.parse("2026-03-01T00:00:00Z") + hours * 3_600_000).toISOString()],
    ],
    { clientId },
  );

describe("summarizeByClient", () => {
  it("groups by client and orders by client id", () => {
    const rows = summarizeByClient([
      reportedAfter("s1", 24, "client-b"),
      reportedAfter("s2", 48, "client-a"),
      sample("s3", [["received", "2026-03-01T00:00:00Z"]], { clientId: "client-a" }),
    ]);
    expect(rows.map((r) => r.clientId)).toEqual(["client-a", "client-b"]);
    expect(rows[0]).toMatchObject({ total: 2, reported: 1, medianTatHours: 48 });
  });

  it("uses the mean of the two middle values for an even count", () => {
    const rows = summarizeByClient([reportedAfter("s1", 20, "c"), reportedAfter("s2", 40, "c")]);
    expect(rows[0]?.medianTatHours).toBe(30);
  });

  it("reports a null median when nothing is reported yet", () => {
    const rows = summarizeByClient([sample("s1", [["received", "2026-03-01T00:00:00Z"]])]);
    expect(rows[0]).toMatchObject({ total: 1, reported: 0, medianTatHours: null });
  });
});
