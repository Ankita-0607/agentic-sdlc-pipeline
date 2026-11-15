import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Stage } from "../types.js";

/**
 * Append-only, hash-chained audit log (JSON Lines).
 *
 * Every model call, tool call, policy decision and human approval becomes one
 * event. Each event stores the hash of the previous one, so editing or
 * deleting a line after the fact breaks the chain and `verifyAuditLog` reports
 * where. This is what lets a reviewer answer "what exactly did the agents do,
 * and who allowed it?" without trusting the agents' own summary.
 */

export interface AuditEvent {
  seq: number;
  ts: string;
  run_id: string;
  stage: Stage;
  type: AuditEventType;
  actor: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export type AuditEventType =
  | "run_started"
  | "stage_started"
  | "stage_completed"
  | "llm_call"
  | "tool_call"
  | "policy_decision"
  | "agent_submit"
  | "approval"
  | "verification"
  | "traceability"
  | "budget_exceeded"
  | "run_completed"
  | "error";

const GENESIS = "0".repeat(64);

function hashEvent(event: Omit<AuditEvent, "hash">): string {
  return crypto.createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

export class AuditLog {
  private seq = 0;
  private prevHash = GENESIS;
  private readonly events: AuditEvent[] = [];

  constructor(
    readonly file: string,
    readonly runId: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      // Continue an existing chain (the build phase resumes the plan phase's log).
      const existing = readAuditLog(file);
      const last = existing.at(-1);
      if (last) {
        this.seq = last.seq;
        this.prevHash = last.hash;
        this.events.push(...existing);
      }
    }
  }

  record(type: AuditEventType, stage: Stage, actor: string, data: Record<string, unknown> = {}): AuditEvent {
    const partial: Omit<AuditEvent, "hash"> = {
      seq: ++this.seq,
      ts: this.now().toISOString(),
      run_id: this.runId,
      stage,
      type,
      actor,
      data,
      prev_hash: this.prevHash,
    };
    const event: AuditEvent = { ...partial, hash: hashEvent(partial) };
    this.prevHash = event.hash;
    this.events.push(event);
    fs.appendFileSync(this.file, JSON.stringify(event) + "\n");
    return event;
  }

  all(): readonly AuditEvent[] {
    return this.events;
  }

  count(type: AuditEventType, predicate: (e: AuditEvent) => boolean = () => true): number {
    return this.events.filter((e) => e.type === type && predicate(e)).length;
  }
}

export function readAuditLog(file: string): AuditEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AuditEvent);
}

export interface VerifyResult {
  ok: boolean;
  events: number;
  /** Sequence number of the first event that fails verification. */
  broken_at?: number;
  reason?: string;
}

export function verifyAuditLog(file: string): VerifyResult {
  let events: AuditEvent[];
  try {
    events = readAuditLog(file);
  } catch (err) {
    return { ok: false, events: 0, broken_at: 0, reason: `unreadable log: ${(err as Error).message}` };
  }
  let prev = GENESIS;
  let expectedSeq = 1;
  for (const event of events) {
    const { hash, ...rest } = event;
    if (event.seq !== expectedSeq) {
      return { ok: false, events: events.length, broken_at: expectedSeq, reason: "missing or reordered event" };
    }
    if (event.prev_hash !== prev) {
      return { ok: false, events: events.length, broken_at: event.seq, reason: "previous-hash mismatch" };
    }
    if (hashEvent(rest) !== hash) {
      return { ok: false, events: events.length, broken_at: event.seq, reason: "event content was modified" };
    }
    prev = hash;
    expectedSeq++;
  }
  return { ok: true, events: events.length };
}
