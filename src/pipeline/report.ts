import type { AuditLog } from "../audit/audit.js";
import type { UsageTracker } from "../llm/usage.js";
import { describeCriterion, renderTraceMarkdown } from "../trace/trace.js";
import { ROLES, type Approval, type PlanState, type RunResult } from "../types.js";

/** The plan as shown to the human approver (terminal prompt or GitHub issue comment). */
export function renderPlanMarkdown(state: PlanState): string {
  const { spec, plan } = state;
  const lines: string[] = [
    `## Proposed plan: ${spec.title}`,
    "",
    `**Risk:** ${spec.risk} — ${spec.risk_rationale}`,
    "",
    "### Problem",
    spec.problem,
    "",
    "### Acceptance criteria",
    ...spec.acceptance_criteria.map((c) => `- **${c.id}** ${c.text}`),
  ];
  if (spec.out_of_scope.length > 0) {
    lines.push("", "### Out of scope", ...spec.out_of_scope.map((s) => `- ${s}`));
  }
  if (spec.open_questions.length > 0) {
    lines.push("", "### Open questions for the approver", ...spec.open_questions.map((q) => `- ${q}`));
  }
  lines.push("", "### Implementation plan", plan.summary, "");
  for (const step of plan.steps) {
    const files = step.files.length > 0 ? ` — \`${step.files.join("`, `")}\`` : "";
    const covers = step.covers.length > 0 ? ` (covers ${step.covers.join(", ")})` : "";
    lines.push(`${step.id}. ${step.description}${files}${covers}`);
  }
  lines.push("", "### Test strategy", plan.test_strategy);
  if (state.plan_policy_warnings.length > 0) {
    lines.push(
      "",
      "### Policy warnings",
      "The plan names files the repository policy does not allow agents to change:",
      ...state.plan_policy_warnings.map((w) => `- ${w}`),
    );
  }
  return lines.join("\n");
}

const STATUS_TEXT: Record<RunResult["status"], string> = {
  awaiting_plan_approval: "Waiting for a human to approve the plan",
  ready_for_human_review: "Ready for human review",
  rejected_at_gate: "Plan rejected at the approval gate",
  failed_verification: "Stopped: the change did not pass verification",
  review_not_converged: "Stopped: the reviewer agent still requested changes after the allowed rework rounds",
  budget_exceeded: "Stopped: the run exceeded its budget",
  error: "Stopped: error",
};

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const num = (n: number) => n.toLocaleString("en-US");

export interface ReportInput {
  state?: PlanState;
  approval?: Approval;
  result: Omit<RunResult, "report_path">;
  usage: UsageTracker;
  audit: AuditLog;
  diffStat?: string;
  durationMs: number;
}

/** The run report: used as the pull request body and saved next to the audit log. */
export function renderReport(input: ReportInput): string {
  const { state, approval, result, usage, audit } = input;
  const lines: string[] = [];
  const title = state?.spec.title ?? "Agent run";

  lines.push(`# Agent run report: ${title}`, "");
  lines.push(`**Status:** ${STATUS_TEXT[result.status]}`);
  if (result.detail) lines.push(`**Detail:** ${result.detail}`);
  lines.push(`**Run id:** \`${result.run_id}\``);
  if (state) lines.push(`**Issue:** ${state.issue.source}`);
  if (result.branch) lines.push(`**Branch:** \`${result.branch}\``);
  lines.push(`**Duration:** ${(input.durationMs / 1000).toFixed(0)}s`, "");

  if (approval) {
    lines.push("## Approval", "");
    const who = approval.kind === "human" ? `**${approval.approver}**` : "repository policy (gate set to `auto`)";
    lines.push(`Plan ${approval.approved ? "approved" : "rejected"} by ${who} at ${approval.at}.`);
    if (approval.note) lines.push(`Note: ${approval.note}`);
    lines.push("");
  }

  if (state) {
    lines.push("## Acceptance criteria", "");
    const lastRound = result.rounds.at(-1);
    const reviewed = new Map((lastRound?.review?.criteria_check ?? []).map((c) => [c.id, c]));
    // The most recent round the pipeline traced; a later round that failed its tests has no trace.
    const traceability = result.rounds.findLast((r) => r.verification?.traceability)?.verification?.traceability;
    const traced = new Map((traceability?.matrix?.criteria ?? []).map((c) => [c.id, c]));
    const header = traceability
      ? ["| Id | Criterion | Tests (run by the pipeline) | Reviewer agent |", "|---|---|---|---|"]
      : ["| Id | Criterion | Reviewer agent |", "|---|---|---|"];
    lines.push(...header);
    for (const c of state.spec.acceptance_criteria) {
      const check = reviewed.get(c.id);
      const verdict = check ? (check.met ? "met" : "**not met**") : "not reviewed";
      const criterion = traced.get(c.id);
      const tests = traceability ? ` ${criterion ? describeCriterion(criterion) : "no report"} |` : "";
      lines.push(`| ${c.id} | ${c.text.replace(/\|/g, "\\|")} |${tests} ${verdict} |`);
    }
    lines.push("");

    if (traceability) {
      lines.push("## Traceability", "");
      lines.push(
        "Tests are matched to criteria by the `[AC…]` tag in the test name, from a test run the pipeline made itself. " +
          "A tag shows that a test claims a criterion and passed; it does not show that the test checks it well.",
        "",
      );
      if (traceability.matrix) lines.push(renderTraceMarkdown(traceability.matrix), "");
      if (traceability.error) lines.push(`The per-test report could not be read: ${traceability.error}`, "");
      if (traceability.gaps.length > 0 && traceability.matrix) {
        lines.push(
          traceability.enforce === "required" ? "Gaps (blocking under this policy):" : "Gaps (reported only under this policy):",
          ...traceability.gaps.map((g) => `- ${g}`),
          "",
        );
      }
    }
  }

  if (result.rounds.length > 0) {
    lines.push("## Rounds", "");
    for (const round of result.rounds) {
      lines.push(`### Round ${round.round}`);
      if (round.implementation) lines.push(`- **Implementer:** ${round.implementation.summary}`);
      if (round.implementation?.notes) lines.push(`- **Implementer notes:** ${round.implementation.notes}`);
      if (round.verification) {
        const v = round.verification;
        lines.push(
          `- **Verification (run by the pipeline, not the agent):** tests ${v.tests.passed ? "passed" : "FAILED"}; ` +
            `${v.changed_files.length} files, ${v.diff_lines} changed lines; ` +
            `${v.policy_violations.length} policy violations`,
        );
        for (const violation of v.policy_violations) lines.push(`  - ${violation}`);
      }
      if (round.review) {
        lines.push(`- **Reviewer agent:** ${round.review.decision} — ${round.review.summary}`);
        for (const f of round.review.findings) {
          lines.push(`  - \`${f.severity}\` ${f.file}: ${f.comment}`);
        }
      }
      lines.push("");
    }
  }

  if (input.diffStat) lines.push("## Change set", "", "```", input.diffStat, "```", "");

  lines.push("## Governance", "");
  const denials = audit.all().filter((e) => e.type === "policy_decision" && e.data.allowed === false);
  lines.push(
    `- Tool calls: ${audit.count("tool_call")}`,
    `- Policy denials: ${denials.length}`,
    ...denials.map((d) => `  - ${d.actor} → \`${String(d.data.tool)}\` ${String(d.data.target ?? "")}: ${String(d.data.reason)}`),
    `- Audit events: ${audit.all().length} (hash-chained; verify with \`asdlc audit verify\`)`,
    "",
  );

  lines.push("## Cost", "", "| Agent | Model calls | Input | Output | Cache read | Est. cost |", "|---|---:|---:|---:|---:|---:|");
  for (const role of ROLES) {
    const u = usage.forRole(role);
    if (u.calls === 0) continue;
    lines.push(
      `| ${role} | ${u.calls} | ${num(u.input_tokens + u.cache_write_tokens)} | ${num(u.output_tokens)} | ${num(u.cache_read_tokens)} | ${usd(u.cost_usd)} |`,
    );
  }
  const total = usage.total();
  lines.push(
    `| **Total** | ${total.calls} | ${num(total.input_tokens + total.cache_write_tokens)} | ${num(total.output_tokens)} | ${num(total.cache_read_tokens)} | **${usd(total.cost_usd)}** |`,
  );
  if (total.unpriced_calls > 0) {
    lines.push("", `${total.unpriced_calls} calls ran on a model with no price in src/config.ts and are not in the estimate.`);
  }
  lines.push("", "_Token counts are in tokens. Cost is an estimate from list prices; the provider invoice is authoritative._", "");

  if (result.status === "ready_for_human_review") {
    lines.push(
      "---",
      "This change was written and reviewed by AI agents under the repository's `agent-policy.yaml`. " +
        "A human approved the plan; a human must review and merge this pull request.",
    );
  }
  return lines.join("\n");
}
