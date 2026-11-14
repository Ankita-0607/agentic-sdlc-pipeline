import readline from "node:readline/promises";
import type { Approval, PlanState } from "../types.js";

/**
 * The human approval gate between planning and implementation.
 *
 * Whether the gate applies is decided by the repository policy
 * (`gates.plan_approval`), not by a command-line flag: the only way to let
 * agents write code without a named approver is to change the reviewed policy
 * file.
 */
export interface ApprovalGate {
  requestPlanApproval(planMarkdown: string, state: PlanState): Promise<Approval>;
}

const now = () => new Date().toISOString();

export const autoApproval = (): Approval => ({
  approved: true,
  kind: "auto",
  approver: "policy",
  note: "gates.plan_approval is set to auto in the repository policy",
  at: now(),
});

export const humanApproval = (approver: string, approved = true, note = ""): Approval => ({
  approved,
  kind: "human",
  approver,
  note,
  at: now(),
});

/** Asks on the terminal. Used by `asdlc run` on a developer machine. */
export class InteractiveGate implements ApprovalGate {
  constructor(private readonly defaultApprover: string) {}

  async requestPlanApproval(planMarkdown: string): Promise<Approval> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`\n${planMarkdown}\n\n`);
      const answer = (await rl.question("Approve this plan and let the agents write code? [y/N] ")).trim();
      const approved = /^y(es)?$/i.test(answer);
      const name = (await rl.question(`Your name for the audit log [${this.defaultApprover}]: `)).trim();
      const note = approved ? "" : (await rl.question("Reason (optional): ")).trim();
      return humanApproval(name || this.defaultApprover, approved, note);
    } finally {
      rl.close();
    }
  }
}

/** A decision that was already made elsewhere, e.g. an `/approve` comment on the GitHub issue. */
export class DecidedGate implements ApprovalGate {
  constructor(private readonly approval: Approval) {}

  async requestPlanApproval(): Promise<Approval> {
    return this.approval;
  }
}
