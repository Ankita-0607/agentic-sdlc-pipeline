import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readAuditLog, verifyAuditLog } from "../src/audit/audit.js";
import { autoApproval, DecidedGate, humanApproval } from "../src/pipeline/gates.js";
import { buildPhase, createContext, planPhase, runPipeline } from "../src/pipeline/pipeline.js";
import type { Issue } from "../src/types.js";
import {
  APPROVE,
  call,
  gitIn,
  GOOD_SOURCE,
  GOOD_TEST,
  IMPLEMENTATION,
  implementCorrectly,
  makeRepo,
  planTurns,
  POLICY_YAML,
  REQUEST_CHANGES,
  ScriptedLlm,
  type ScriptedTurn,
} from "./helpers.js";

const ISSUE: Issue = { source: "test-issue.md", number: 7, title: "Formal greeting", body: "Please add greetFormal." };
const approveAs = (name: string) => new DecidedGate(humanApproval(name));

function setup(script: Record<string, ScriptedTurn[]>, policyYaml = POLICY_YAML) {
  const root = makeRepo(policyYaml);
  const llm = new ScriptedLlm({ ...planTurns(), ...script });
  const ctx = createContext({ root, llm, runId: "run-test" });
  return { root, llm, ctx };
}

const branchOf = (root: string) => gitIn(root, "rev-parse", "--abbrev-ref", "HEAD").trim();

describe("pipeline: happy path", () => {
  it("takes an issue to a committed, reviewed change on a branch", async () => {
    const { root, ctx } = setup({
      submit_implementation: implementCorrectly(),
      submit_review: [[call("run_tests")], [call("submit_review", APPROVE)]],
    });
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));

    expect(result.status).toBe("ready_for_human_review");
    expect(result.branch).toBe("agent/issue-7-greet-politely");
    expect(branchOf(root)).toBe(result.branch);
    expect(result.rounds).toHaveLength(1);
    expect(result.rounds[0]!.verification).toMatchObject({ passed: true, policy_violations: [] });

    const commitMessage = gitIn(root, "log", "-1", "--format=%B");
    expect(commitMessage).toContain("Greet politely (#7)");
    expect(commitMessage).toContain("Plan-Approved-By: ankita");
    expect(gitIn(root, "show", "--stat", "--format=", "HEAD")).toMatch(/src\/greet.cjs[\s\S]*test\/formal.test.cjs/);
    expect(gitIn(root, "status", "--porcelain").trim()).toBe("");
  });

  it("writes a report and a verifiable audit trail covering every stage", async () => {
    const { ctx } = setup({
      submit_implementation: implementCorrectly(),
      submit_review: [[call("submit_review", APPROVE)]],
    });
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));

    const report = fs.readFileSync(result.report_path, "utf8");
    expect(report).toContain("**Status:** Ready for human review");
    expect(report).toContain("Plan approved by **ankita**");
    expect(report).toContain("| AC1 |");
    expect(report).toContain("A human approved the plan; a human must review and merge this pull request.");

    const auditFile = path.join(ctx.runDir, "audit.jsonl");
    expect(verifyAuditLog(auditFile).ok).toBe(true);
    const events = readAuditLog(auditFile);
    expect(events[0]!.type).toBe("run_started");
    expect(events.at(-1)).toMatchObject({ type: "run_completed", data: { status: "ready_for_human_review" } });
    expect(events.filter((e) => e.type === "stage_started").map((e) => e.data.role)).toEqual([
      "spec",
      "planner",
      "implementer",
      "reviewer",
    ]);
    expect(events.find((e) => e.type === "approval")).toMatchObject({ actor: "ankita", data: { kind: "human" } });
  });

  it("does not show the reviewer the implementer's self-report", async () => {
    const { llm, ctx } = setup({
      submit_implementation: [
        ...implementCorrectly().slice(0, 3),
        [call("submit_implementation", { ...IMPLEMENTATION, summary: "TRUST-ME-MARKER everything is perfect" })],
      ],
      submit_review: [[call("submit_review", APPROVE)]],
    });
    await runPipeline(ctx, ISSUE, approveAs("ankita"));
    const reviewerRequest = llm.requests.find((r) => r.tools.some((t) => t.name === "submit_review"))!;
    const seen = JSON.stringify(reviewerRequest.messages);
    expect(seen).not.toContain("TRUST-ME-MARKER");
    expect(seen).toContain("greetFormal"); // it does see the diff
  });
});

describe("pipeline: approval gate", () => {
  it("writes no code when the plan is rejected", async () => {
    const { root, llm, ctx } = setup({});
    const result = await runPipeline(ctx, ISSUE, new DecidedGate(humanApproval("ankita", false, "Out of scope this quarter")));

    expect(result.status).toBe("rejected_at_gate");
    expect(branchOf(root)).toBe("main");
    expect(gitIn(root, "status", "--porcelain").trim()).toBe("");
    expect(llm.requests.some((r) => r.tools.some((t) => t.name === "submit_implementation"))).toBe(false);
    expect(fs.readFileSync(result.report_path, "utf8")).toContain("Out of scope this quarter");
  });

  it("refuses an automatic approval when the policy requires a human", async () => {
    const { root, ctx } = setup({});
    const state = await planPhase(ctx, ISSUE);
    const result = await buildPhase(ctx, state, autoApproval());
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/requires a human to approve the plan/);
    expect(branchOf(root)).toBe("main");
  });

  it("skips the gate only when the policy itself says auto", async () => {
    const { ctx } = setup(
      { submit_implementation: implementCorrectly(), submit_review: [[call("submit_review", APPROVE)]] },
      POLICY_YAML.replace("plan_approval: required", "plan_approval: auto"),
    );
    const neverAsked = { requestPlanApproval: () => Promise.reject(new Error("gate should not be consulted")) };
    const result = await runPipeline(ctx, ISSUE, neverAsked);
    expect(result.status).toBe("ready_for_human_review");
    expect(fs.readFileSync(result.report_path, "utf8")).toContain("repository policy (gate set to `auto`)");
  });

  it("flags planned files the policy will not allow, before anyone approves", async () => {
    const root = makeRepo();
    const llm = new ScriptedLlm({
      submit_spec: planTurns().submit_spec!,
      submit_plan: [
        [
          call("submit_plan", {
            summary: "Bump a dependency.",
            steps: [{ id: "1", description: "Edit manifest", files: ["package.json"], covers: ["AC1"] }],
            test_strategy: "n/a",
          }),
        ],
      ],
    });
    const ctx = createContext({ root, llm, runId: "run-test" });
    const state = await planPhase(ctx, ISSUE);
    expect(state.plan_policy_warnings).toEqual(["package.json: protected path"]);
    expect(fs.readFileSync(path.join(ctx.runDir, "plan.md"), "utf8")).toContain("### Policy warnings");
  });
});

describe("pipeline: verification and rework", () => {
  it("sends failing work back with the test output, then accepts the fix", async () => {
    const { llm, ctx } = setup({
      submit_implementation: [
        // Round 1: a bug, and the agent claims the tests pass without running them.
        [call("write_file", { path: "src/greet.cjs", content: GOOD_SOURCE.replace("Good day", "Good night") })],
        [call("write_file", { path: "test/formal.test.cjs", content: GOOD_TEST })],
        [call("submit_implementation", IMPLEMENTATION)],
        // Round 2: the fix.
        [call("write_file", { path: "src/greet.cjs", content: GOOD_SOURCE })],
        [call("run_tests")],
        [call("submit_implementation", IMPLEMENTATION)],
      ],
      submit_review: [[call("submit_review", APPROVE)]],
    });
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));

    expect(result.status).toBe("ready_for_human_review");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]!.verification!.tests.passed).toBe(false);
    expect(result.rounds[0]!.review).toBeUndefined(); // unverified work is never sent to review
    const implementerCalls = llm.requests.filter((r) => r.tools.some((t) => t.name === "submit_implementation"));
    expect(JSON.stringify(implementerCalls[3]!.messages[0])).toContain("The pipeline's own test run failed");
  });

  it("loops on reviewer feedback and stops when the reviewer approves", async () => {
    const { llm, ctx } = setup({
      submit_implementation: [...implementCorrectly(), [call("run_tests")], [call("submit_implementation", IMPLEMENTATION)]],
      submit_review: [[call("submit_review", REQUEST_CHANGES)], [call("submit_review", APPROVE)]],
    });
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));

    expect(result.status).toBe("ready_for_human_review");
    expect(result.rounds.map((r) => r.review!.decision)).toEqual(["request_changes", "approve"]);
    const reworkPrompt = JSON.stringify(
      llm.requests.filter((r) => r.tools.some((t) => t.name === "submit_implementation"))[4]!.messages[0],
    );
    expect(reworkPrompt).toContain("Empty name is not handled.");
  });

  it("stops without committing when the reviewer never approves within the rework limit", async () => {
    const { root, ctx } = setup({
      submit_implementation: [...implementCorrectly(), [call("submit_implementation", IMPLEMENTATION)]],
      submit_review: [[call("submit_review", REQUEST_CHANGES)], [call("submit_review", REQUEST_CHANGES)]],
    });
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));

    expect(result.status).toBe("review_not_converged");
    expect(result.rounds).toHaveLength(2); // 1 attempt + max_rework_rounds (1)
    expect(result.commit).toBeUndefined();
    expect(gitIn(root, "log", "--oneline").trim().split("\n")).toHaveLength(1);
  });

  it("treats an approval that carries a blocking finding as a request for changes", async () => {
    const contradictory = {
      ...APPROVE,
      findings: [{ severity: "blocking", file: "src/greet.cjs", comment: "Crashes on null." }],
    };
    const { ctx } = setup({
      submit_implementation: [...implementCorrectly(), [call("submit_implementation", IMPLEMENTATION)]],
      submit_review: [[call("submit_review", contradictory)], [call("submit_review", contradictory)]],
    });
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));
    expect(result.status).toBe("review_not_converged");
    expect(result.rounds[0]!.review!.decision).toBe("request_changes");
  });

  it("catches files created outside the write tools, such as test side effects", async () => {
    const policyYaml = POLICY_YAML.replace(
      'test: "node test/run.cjs"',
      `test: "node test/run.cjs && node -e \\"require('fs').writeFileSync('leak.txt','x')\\""`,
    ).replace("max_rework_rounds: 1", "max_rework_rounds: 0");
    const { ctx } = setup({ submit_implementation: implementCorrectly() }, policyYaml);
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));

    expect(result.status).toBe("failed_verification");
    expect(result.rounds[0]!.verification!.policy_violations).toEqual([
      "workspace.writable: leak.txt was changed but is not a writable path",
    ]);
    expect(result.commit).toBeUndefined();
  });

  it("fails verification when the agents changed nothing", async () => {
    const { ctx } = setup(
      { submit_implementation: [[call("submit_implementation", IMPLEMENTATION)]] },
      POLICY_YAML.replace("max_rework_rounds: 1", "max_rework_rounds: 0"),
    );
    const result = await runPipeline(ctx, ISSUE, approveAs("ankita"));
    expect(result.status).toBe("failed_verification");
    expect(result.rounds[0]!.verification!.policy_violations).toContain("no files were changed");
  });
});

describe("pipeline: limits", () => {
  it("stops the run when the budget is exhausted and says so in the report", async () => {
    const { ctx } = setup(
      { submit_implementation: implementCorrectly() },
      // Planning takes 4 scripted calls (6,000 tokens); the build phase starts over budget.
      POLICY_YAML.replace("max_total_tokens: 1000000", "max_total_tokens: 5000"),
    );
    const state = await planPhase(ctx, ISSUE);
    const result = await buildPhase(ctx, state, humanApproval("ankita"));

    expect(result.status).toBe("budget_exceeded");
    expect(fs.readFileSync(result.report_path, "utf8")).toContain("exceeded its budget");
    expect(readAuditLog(path.join(ctx.runDir, "audit.jsonl")).some((e) => e.type === "budget_exceeded")).toBe(true);
  });

  it("refuses to build on a dirty working tree", async () => {
    const { root, ctx } = setup({});
    const state = await planPhase(ctx, ISSUE);
    fs.writeFileSync(path.join(root, "src/local-edit.cjs"), "// someone's uncommitted work\n");
    const result = await buildPhase(ctx, state, humanApproval("ankita"));
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/uncommitted changes/);
  });

  it("resumes the build phase from saved state in a new process, continuing the audit chain", async () => {
    const { root, ctx } = setup({});
    await planPhase(ctx, ISSUE);
    const saved = JSON.parse(fs.readFileSync(path.join(ctx.runDir, "state.json"), "utf8"));

    const llm2 = new ScriptedLlm({
      submit_implementation: implementCorrectly(),
      submit_review: [[call("submit_review", APPROVE)]],
    });
    const ctx2 = createContext({ root, llm: llm2, runId: saved.run_id, runDir: ctx.runDir });
    const result = await buildPhase(ctx2, saved, humanApproval("ankita"));

    expect(result.status).toBe("ready_for_human_review");
    expect(verifyAuditLog(path.join(ctx.runDir, "audit.jsonl")).ok).toBe(true);
  });
});
