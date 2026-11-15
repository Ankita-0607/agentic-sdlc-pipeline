import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AgentError, runAgent, type AgentRuntime, type AgentSpec } from "../agent/loop.js";
import { collectTestReport, runTestCommand } from "../agent/tools.js";
import { implementerAgent, plannerAgent, reviewerAgent, specAgent, type ReworkContext } from "../agents/roles.js";
import { AuditLog } from "../audit/audit.js";
import { DEFAULT_MODEL } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import { BudgetExceededError, UsageTracker } from "../llm/usage.js";
import { loadPolicy, PolicyEngine } from "../policy/policy.js";
import { buildTrace, traceGaps } from "../trace/trace.js";
import type {
  Approval,
  Issue,
  PlanState,
  Review,
  Role,
  RoundRecord,
  RunResult,
  RunStatus,
  Spec,
  TraceabilityResult,
  VerificationResult,
} from "../types.js";
import { autoApproval, type ApprovalGate } from "./gates.js";
import { renderPlanMarkdown, renderReport } from "./report.js";
import { slugify, Workspace } from "./workspace.js";

/**
 * The orchestrator. It is ordinary deterministic code: the stage order, the
 * approval gate, verification and the rework limit are decided here, never by
 * a model. Agents fill in the stages; they do not control the flow.
 *
 *   plan phase:   intake -> spec agent -> planner agent -> (stop, wait for approval)
 *   build phase:  approval -> [ implementer agent -> verification -> reviewer agent ] x N -> commit
 */

export interface PipelineContext {
  root: string;
  runId: string;
  runDir: string;
  llm: LlmClient;
  policy: PolicyEngine;
  audit: AuditLog;
  usage: UsageTracker;
  workspace: Workspace;
  log: (line: string) => void;
  startedAt: number;
}

export interface CreateContextOptions {
  root: string;
  llm: LlmClient;
  runId?: string;
  /** Where run artifacts (audit log, plan, report) are written. Defaults to <root>/.agent-runs/<runId>. */
  runDir?: string;
  log?: (line: string) => void;
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

export function createContext(options: CreateContextOptions): PipelineContext {
  const root = path.resolve(options.root);
  const runId = options.runId ?? newRunId();
  const runDir = options.runDir ?? path.join(root, ".agent-runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  // The policy is read once, at the start, from the checked-out base commit.
  const policy = new PolicyEngine(loadPolicy(root), root);
  const workspace = new Workspace(root);
  workspace.ignoreLocally(".agent-runs/");
  return {
    root,
    runId,
    runDir,
    llm: options.llm,
    policy,
    audit: new AuditLog(path.join(runDir, "audit.jsonl"), runId),
    usage: new UsageTracker(),
    workspace,
    log: options.log ?? (() => {}),
    startedAt: Date.now(),
  };
}

function modelFor(role: Role, ctx: PipelineContext): string {
  return ctx.policy.policy.models?.[role] ?? DEFAULT_MODEL;
}

async function runStage<T>(ctx: PipelineContext, spec: AgentSpec<T>, changed: Set<string>): Promise<T> {
  const runtime: AgentRuntime = {
    llm: ctx.llm,
    policy: ctx.policy,
    audit: ctx.audit,
    usage: ctx.usage,
    changed,
    model: modelFor(spec.role, ctx),
  };
  ctx.log(`▸ ${spec.role} agent started`);
  ctx.audit.record("stage_started", spec.stage, "pipeline", { role: spec.role, model: runtime.model });
  const { result, turns } = await runAgent(spec, runtime);
  ctx.audit.record("stage_completed", spec.stage, "pipeline", { role: spec.role, turns });
  ctx.log(`✓ ${spec.role} agent finished in ${turns} turns`);
  return result;
}

const writeJson = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

/** Phase 1: issue -> spec -> plan. Writes nothing to the repository. */
export async function planPhase(ctx: PipelineContext, issue: Issue): Promise<PlanState> {
  const baseCommit = ctx.workspace.headCommit();
  ctx.audit.record("run_started", "intake", "pipeline", {
    issue: issue.source,
    title: issue.title,
    base_commit: baseCommit,
    policy_sha256: crypto.createHash("sha256").update(JSON.stringify(ctx.policy.policy)).digest("hex"),
  });

  const noWrites = new Set<string>();
  const spec = await runStage(ctx, specAgent(issue, ctx.policy), noWrites);
  const plan = await runStage(ctx, plannerAgent(issue, spec, ctx.policy), noWrites);

  const state: PlanState = {
    run_id: ctx.runId,
    issue,
    spec,
    plan,
    plan_policy_warnings: ctx.policy.checkPlannedFiles(plan.steps.flatMap((s) => s.files)),
    base_commit: baseCommit,
  };
  writeJson(path.join(ctx.runDir, "state.json"), state);
  fs.writeFileSync(path.join(ctx.runDir, "plan.md"), renderPlanMarkdown(state) + "\n");
  return state;
}

/**
 * Which acceptance criteria have a passing test tagged with their id. Read
 * from a per-test report the pipeline produces itself, not from the
 * implementer's criteria_status or the reviewer's criteria_check.
 */
async function trace(ctx: PipelineContext, spec: Spec): Promise<TraceabilityResult | undefined> {
  const config = ctx.policy.policy.traceability;
  if (!config) return undefined;
  ctx.log("▸ verification: matching test results to acceptance criteria");
  const report = await collectTestReport(ctx.policy);
  const matrix = report.tests ? buildTrace(spec, report.tests) : null;
  const gaps = matrix ? traceGaps(matrix) : [`the per-test report could not be read: ${report.error}`];
  const result: TraceabilityResult = { enforce: config.enforce, matrix, gaps, ...(report.error ? { error: report.error } : {}) };
  ctx.audit.record("traceability", "verify", "pipeline", {
    enforce: config.enforce,
    spec_sha256: crypto.createHash("sha256").update(JSON.stringify(spec)).digest("hex"),
    criteria: matrix?.criteria.map((c) => ({ id: c.id, status: c.status, tests: c.tests.length })) ?? null,
    unknown_ids: matrix?.unknown_ids ?? [],
    gaps,
    error: report.error ?? null,
  });
  return result;
}

/** Tests and policy, checked by the pipeline itself rather than taken from the agent's report. */
async function verify(ctx: PipelineContext, spec: Spec): Promise<VerificationResult> {
  ctx.log("▸ verification: running tests and re-checking the change set against policy");
  const tests = await runTestCommand(ctx.policy);
  // Only worth a second test run when the first one passed; a failing suite goes back to the implementer anyway.
  const traceability = tests.passed ? await trace(ctx, spec) : undefined;
  const traceBlocks = traceability?.enforce === "required" && traceability.gaps.length > 0;

  // Stage after the test run so that files created as a side effect are seen too.
  ctx.workspace.stageAll();
  const changed = ctx.workspace.changedFiles();
  const diffLines = ctx.workspace.diffLineCount();
  const violations = ctx.policy.checkChangeSet(changed, diffLines);
  if (changed.length === 0) violations.push("no files were changed");

  for (const file of changed) {
    if (file.status === "D") continue;
    const abs = path.join(ctx.root, file.path);
    const secret = fs.existsSync(abs) ? ctx.policy.findSecret(fs.readFileSync(abs, "utf8")) : null;
    if (secret) violations.push(`secrets: ${file.path} contains what looks like a ${secret}`);
  }

  const result: VerificationResult = {
    passed: tests.passed && violations.length === 0 && !traceBlocks,
    tests: { passed: tests.passed, exit_code: tests.exit_code, output_tail: tests.output_tail },
    policy_violations: violations,
    changed_files: changed.map((f) => f.path),
    diff_lines: diffLines,
    ...(traceability ? { traceability } : {}),
  };
  ctx.audit.record("verification", "verify", "pipeline", {
    passed: result.passed,
    tests_passed: tests.passed,
    exit_code: tests.exit_code,
    changed_files: result.changed_files,
    diff_lines: diffLines,
    policy_violations: violations,
  });
  ctx.log(result.passed ? "✓ verification passed" : "✗ verification failed");
  return result;
}

/** An approval with blocking or major findings attached is not an approval. */
function effectiveDecision(review: Review): Review["decision"] {
  const mustFix = review.findings.some((f) => f.severity === "blocking" || f.severity === "major");
  const unmet = review.criteria_check.some((c) => !c.met);
  return review.decision === "approve" && !mustFix && !unmet ? "approve" : "request_changes";
}

const AGENT_AUTHOR = {
  name: process.env.ASDLC_GIT_AUTHOR_NAME ?? "agentic-sdlc-pipeline",
  email: process.env.ASDLC_GIT_AUTHOR_EMAIL ?? "agentic-sdlc-pipeline@users.noreply.github.com",
};

/** Phase 2: approved plan -> code -> verification -> review -> commit on a branch. */
export async function buildPhase(ctx: PipelineContext, state: PlanState, approval: Approval): Promise<RunResult> {
  const rounds: RoundRecord[] = [];
  let status: RunStatus = "error";
  let detail = "";
  let branch: string | undefined;
  let commit: string | undefined;
  let diffStat: string | undefined;

  try {
    const required = ctx.policy.policy.gates.plan_approval === "required";
    if (required && approval.kind !== "human") {
      throw new Error("policy requires a human to approve the plan (gates.plan_approval: required)");
    }
    ctx.audit.record("approval", "approval", approval.approver, { ...approval });
    if (!approval.approved) {
      status = "rejected_at_gate";
      detail = approval.note || "The plan was not approved.";
      return finish();
    }

    if (!ctx.workspace.isClean()) {
      throw new Error("the working tree has uncommitted changes; the pipeline only runs on a clean checkout");
    }
    const head = ctx.workspace.headCommit();
    if (head !== state.base_commit) {
      ctx.audit.record("error", "approval", "pipeline", {
        warning: "base_drift",
        planned_on: state.base_commit,
        building_on: head,
      });
      ctx.log(`! the repository moved since the plan was written (${state.base_commit.slice(0, 7)} → ${head.slice(0, 7)})`);
    }

    const label = state.issue.number ? `issue-${state.issue.number}` : ctx.runId;
    branch = `agent/${label}-${slugify(state.spec.title)}`;
    ctx.workspace.createBranch(branch);

    const changed = new Set<string>();
    const maxRounds = 1 + ctx.policy.policy.limits.max_rework_rounds;
    let rework: ReworkContext | undefined;
    let approved = false;

    for (let round = 1; round <= maxRounds; round++) {
      const record: RoundRecord = { round };
      rounds.push(record);

      record.implementation = await runStage(
        ctx,
        implementerAgent(state.spec, state.plan, ctx.policy, rework),
        changed,
      );

      record.verification = await verify(ctx, state.spec);
      if (!record.verification.passed) {
        status = "failed_verification";
        const v = record.verification;
        detail = !v.tests.passed
          ? "The test command failed."
          : v.policy_violations.length > 0
            ? v.policy_violations.join("; ")
            : `Traceability: ${(v.traceability?.gaps ?? []).join("; ")}`;
        rework = { round: round + 1, verification: record.verification };
        continue;
      }

      // The reviewer sees the spec, the plan and the diff; not the implementer's self-report.
      const review = await runStage(
        ctx,
        reviewerAgent(state.spec, state.plan, ctx.workspace.diff(), ctx.policy, record.verification.traceability),
        changed,
      );
      record.review = { ...review, decision: effectiveDecision(review) };
      if (record.review.decision === "approve") {
        approved = true;
        break;
      }
      status = "review_not_converged";
      detail = `Reviewer agent requested changes in round ${round}.`;
      rework = { round: round + 1, review: record.review };
    }

    diffStat = ctx.workspace.diffStat();
    if (approved) {
      const issueRef = state.issue.number ? ` (#${state.issue.number})` : "";
      commit = ctx.workspace.commit(
        [
          `${state.spec.title}${issueRef}`,
          "",
          state.plan.summary,
          "",
          `Agent-Run: ${ctx.runId}`,
          `Plan-Approved-By: ${approval.kind === "human" ? approval.approver : "policy (auto)"}`,
        ].join("\n"),
        AGENT_AUTHOR,
      );
      status = "ready_for_human_review";
      detail = `Committed ${commit.slice(0, 7)} on ${branch}.`;
    }
    return finish();
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      status = "budget_exceeded";
      detail = err.message;
      ctx.audit.record("budget_exceeded", "implement", "pipeline", { limit: err.limit, message: err.message });
    } else {
      status = "error";
      detail = err instanceof AgentError || err instanceof Error ? err.message : String(err);
      ctx.audit.record("error", "implement", "pipeline", { message: detail });
    }
    return finish();
  }

  function finish(): RunResult {
    const reportPath = path.join(ctx.runDir, "report.md");
    const result = { run_id: ctx.runId, status, branch, commit, rounds, detail };
    ctx.audit.record("run_completed", "publish", "pipeline", {
      status,
      detail,
      branch,
      commit,
      cost_usd: Number(ctx.usage.total().cost_usd.toFixed(4)),
      total_tokens: ctx.usage.totalTokens(),
    });
    fs.writeFileSync(
      reportPath,
      renderReport({
        state,
        approval,
        result,
        usage: ctx.usage,
        audit: ctx.audit,
        diffStat,
        durationMs: Date.now() - ctx.startedAt,
      }) + "\n",
    );
    writeJson(path.join(ctx.runDir, "result.json"), {
      ...result,
      usage: ctx.usage.total(),
      duration_ms: Date.now() - ctx.startedAt,
    });
    // The traceability evidence record for this run: which criteria the last
    // verified change set was shown to satisfy, by which tests, and who approved the plan.
    const lastTrace = rounds.findLast((r) => r.verification?.traceability)?.verification?.traceability;
    if (lastTrace) {
      writeJson(path.join(ctx.runDir, "trace.json"), {
        run_id: ctx.runId,
        issue: state.issue.source,
        spec_sha256: crypto.createHash("sha256").update(JSON.stringify(state.spec)).digest("hex"),
        base_commit: state.base_commit,
        commit: commit ?? null,
        status,
        plan_approved_by: approval.kind === "human" ? approval.approver : "policy (auto)",
        ...lastTrace,
      });
    }
    ctx.log(`■ ${status}: ${detail}`);
    return { ...result, report_path: reportPath };
  }
}

/** Both phases in one process, with the approval gate in between. */
export async function runPipeline(ctx: PipelineContext, issue: Issue, gate: ApprovalGate): Promise<RunResult> {
  const state = await planPhase(ctx, issue);
  const approval =
    ctx.policy.policy.gates.plan_approval === "auto"
      ? autoApproval()
      : await gate.requestPlanApproval(renderPlanMarkdown(state), state);
  return buildPhase(ctx, state, approval);
}
