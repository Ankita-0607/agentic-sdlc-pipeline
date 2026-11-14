import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLog, readAuditLog, verifyAuditLog } from "../src/audit/audit.js";
import { tempDir } from "./helpers.js";

function writeLog(events = 4) {
  const file = path.join(tempDir(), "audit.jsonl");
  const log = new AuditLog(file, "run-1");
  for (let i = 0; i < events; i++) log.record("tool_call", "implement", "implementer", { n: i });
  return { file, log };
}

const rewrite = (file: string, mutate: (lines: string[]) => string[]) =>
  fs.writeFileSync(file, mutate(fs.readFileSync(file, "utf8").trimEnd().split("\n")).join("\n") + "\n");

describe("audit log", () => {
  it("chains every event to the previous one and verifies", () => {
    const { file } = writeLog();
    const events = readAuditLog(file);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(events[1]!.prev_hash).toBe(events[0]!.hash);
    expect(verifyAuditLog(file)).toEqual({ ok: true, events: 4 });
  });

  it("detects an edited event", () => {
    const { file } = writeLog();
    rewrite(file, (lines) => {
      const event = JSON.parse(lines[1]!);
      event.data.n = 999;
      lines[1] = JSON.stringify(event);
      return lines;
    });
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, broken_at: 2, reason: "event content was modified" });
  });

  it("detects a deleted event", () => {
    const { file } = writeLog();
    rewrite(file, (lines) => [lines[0]!, lines[2]!, lines[3]!]);
    expect(verifyAuditLog(file)).toMatchObject({ ok: false, broken_at: 2 });
  });

  it("detects an event whose hash was recomputed without fixing the chain", () => {
    const { file } = writeLog();
    rewrite(file, (lines) => {
      const event = JSON.parse(lines[2]!);
      event.prev_hash = "f".repeat(64);
      lines[2] = JSON.stringify(event);
      return lines;
    });
    expect(verifyAuditLog(file).ok).toBe(false);
  });

  it("continues the chain when a later phase reopens the same log", () => {
    const { file } = writeLog(2);
    const resumed = new AuditLog(file, "run-1");
    resumed.record("approval", "approval", "ankita", { approved: true });
    expect(verifyAuditLog(file)).toEqual({ ok: true, events: 3 });
    expect(resumed.all()).toHaveLength(3);
  });
});
