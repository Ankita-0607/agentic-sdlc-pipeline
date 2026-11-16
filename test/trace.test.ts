import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { implementerAgent, reviewerAgent } from "../src/agents/roles.js";
import { readAuditLog, verifyAuditLog } from "../src/audit/audit.js";
import { DecidedGate, humanApproval } from "../src/pipeline/gates.js";
import { createContext, runPipeline } from "../src/pipeline/pipeline.js";
import { parsePolicy, PolicyEngine } from "../src/policy/policy.js";
import {
  bracketTokens,
  buildTrace,
  describeCriterion,
  parseTestReport,
  renderTraceMarkdown,
  traceGaps,
  type TestOutcome,
} from "../src/trace/trace.js";
import type { Issue, Spec } from "../src/types.js";
import {
  APPROVE,
  call,
  gitIn,
  GOOD_TEST,
  IMPLEMENTATION,
  implementCorrectly,
  makeRepo,
  PLAN,
  planTurns,
  POLICY_YAML,
  ScriptedLlm,
  SPEC,
  tempDir,
  type ScriptedTurn,
} from "./helpers.js";

const SPEC3: Spec = {
  ...SPEC,
  acceptance_criteria: [
    { id: "AC1", text: "Formal greeting is returned." },
    { id: "AC2", text: "Empty name is rejected." },
    { id: "AC3", text: "Whitespace | pipes are trimmed." },
  ],
};

const t = (name: string, status: TestOutcome["status"] = "passed", file = "test/a.test.ts"): TestOutcome => ({
  file,
  name,
  status,
});

describe("trace: reading tags from test names", () => {
  it("finds every bracketed token, including comma-separated ids", () => {
    expect(bracketTokens("greet [AC1, AC2] formally [slow]")).toEqual(["AC1", "AC2", "slow"]);
    expect(bracketTokens("no tags here")).toEqual([]);
    expect(bracketTokens("empty [] brackets")).toEqual([]);
  });
});

describe("trace: building the matrix", () => {
  it("marks a criterion verified when a tagged test passed and none failed", () => {
    const matrix = buildTrace(SPEC3, [t("[AC1] greets formally"), t("[AC1] keeps the name")]);
    expect(matrix.criteria[0]).toMatchObject({ id: "AC1", status: "verified" });
    expect(matrix.criteria[0]!.tests).toHaveLength(2);
    expect(describeCriterion(matrix.criteria[0]!)).toBe("verified (2 tests)");
  });

  it("marks a criterion failing when any tagged test failed", () => {
    const matrix = buildTrace(SPEC3, [t("[AC2] rejects empty"), t("[AC2] rejects blank", "failed")]);
    expect(matrix.criteria[1]!.status).toBe("failing");
  });

  it("does not count skipped tests as evidence", () => {
    const matrix = buildTrace(SPEC3, [t("[AC3] trims", "skipped")]);
    expect(matrix.criteria[2]!.status).toBe("untested");
    expect(traceGaps(matrix)).toContain("AC3 has no passing test tagged [AC3] (the tagged tests were skipped)");
  });

  it("lets one test cover several criteria and matches ids case-insensitively", () => {
    const matrix = buildTrace(SPEC3, [t("[ac1, AC2] greets and validates")]);
    expect(matrix.criteria.map((c) => c.status)).toEqual(["verified", "verified", "untested"]);
    expect(matrix.untagged_tests).toBe(0);
  });

  it("reports tags shaped like criterion ids that are not in the spec, and ignores other brackets", () => {
    const matrix = buildTrace(SPEC3, [t("[AC9] something else"), t("[slow] big input"), t("handles [1, 2]")]);
    expect(matrix.unknown_ids).toEqual(["AC9"]);
    expect(matrix.untagged_tests).toBe(3);
    expect(matrix.total_tests).toBe(3);
    expect(traceGaps(matrix)).toContain("a test is tagged [AC9], which is not an acceptance criterion in the spec");
  });

  it("has no gaps when every criterion is verified", () => {
    const matrix = buildTrace(SPEC3, [t("[AC1] a"), t("[AC2] b"), t("[AC3] c"), t("untagged")]);
    expect(traceGaps(matrix)).toEqual([]);
    expect(matrix.untagged_tests).toBe(1);
  });

  it("renders a Markdown table that escapes pipes in criterion text", () => {
    const markdown = renderTraceMarkdown(buildTrace(SPEC3, [t("[AC1] greets formally"), t("[AC2] rejects", "failed")]));
    expect(markdown).toContain("| AC1 | Formal greeting is returned. | verified | ✓ [AC1] greets formally (`test/a.test.ts`) |");
    expect(markdown).toContain("| AC2 | Empty name is rejected. | **failing** |");
    expect(markdown).toContain("Whitespace \\| pipes are trimmed.");
    expect(markdown).toContain("1 of 3 criteria verified by passing tests.");
  });
});

describe("trace: reading a Jest/Vitest JSON report", () => {
  it("flattens the report and makes file paths relative to the repository", () => {
    const root = path.resolve("/repo");
    const tests = parseTestReport(
      {
        numTotalTests: 3,
        testResults: [
          {
            name: path.join(root, "test", "greet.test.ts"),
            status: "failed",
            assertionResults: [
              { ancestorTitles: ["greet"], fullName: "greet [AC1] is formal", title: "[AC1] is formal", status: "passed" },
              { fullName: "greet [AC2] rejects empty", title: "[AC2] rejects empty", status: "failed" },
              { title: "later", status: "pending" },
            ],
          },
        ],
      },
      root,
    );
    expect(tests).toEqual([
      { file: "test/greet.test.ts", name: "greet [AC1] is formal", status: "passed" },
      { file: "test/greet.test.ts", name: "greet [AC2] rejects empty", status: "failed" },
      { file: "test/greet.test.ts", name: "later", status: "skipped" },
    ]);
  });

  it("rejects something that is not a test report", () => {
    expect(() => parseTestReport({ results: [] })).toThrow();
  });
});

const TRACE_YAML = (enforce: string, command = "node test/report.cjs {report}") =>
  `${POLICY_YAML}traceability:\n  report_command: "${command}"\n  enforce: ${enforce}\n`;

describe("trace: policy", () => {
  it("is off unless the policy has a traceability section", () => {
    expect(parsePolicy(POLICY_YAML).traceability).toBeUndefined();
  });

  it("defaults to report-only and requires the {report} placeholder", () => {
    const policy = parsePolicy(`${POLICY_YAML}traceability:\n  report_command: "node test/report.cjs {report}"\n`);
    expect(policy.traceability).toEqual({ report_command: "node test/report.cjs {report}", enforce: "report" });
    expect(() => parsePolicy(`${POLICY_YAML}traceability:\n  report_command: "node test/report.cjs"\n`)).toThrow(
      /\{report\}/,
    );
  });

  it("tells the implementer to tag tests only when traceability is on", () => {
    const root = tempDir();
    const off = implementerAgent(SPEC, PLAN, new PolicyEngine(parsePolicy(POLICY_YAML), root));
    const on = implementerAgent(SPEC, PLAN, new PolicyEngine(parsePolicy(TRACE_YAML("required")), root));
    expect(off.system).not.toContain("square brackets");
    expect(on.system).toContain("square brackets");
    expect(on.system).toContain("the change is sent back to you");
  });

  it("shows the reviewer the pipeline's trace, with a warning about what it does not prove", () => {
    const root = tempDir();
    const matrix = buildTrace(SPEC, [t("[AC1] greets formally")]);
    const reviewer = reviewerAgent(SPEC, PLAN, "diff", new PolicyEngine(parsePolicy(TRACE_YAML("report")), root), {
      enforce: "report",
      matrix,
      gaps: [],
    });
    expect(reviewer.task).toContain("<test_trace>");
    expect(reviewer.task).toContain("[AC1] greets formally");
    expect(reviewer.task).toContain("does not show that a tagged test really checks its criterion");
  });
});

/**
 * A stand-in for `vitest run --reporter=json` in the fixture repository: each
 * *.test.cjs file is one test, named by its first-line "// test: ..." comment.
 */
const REPORT_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  "const testResults = [];",
  "for (const f of fs.readdirSync(__dirname).sort()) {",
  '  if (!f.endsWith(".test.cjs")) continue;',
  "  const file = path.join(__dirname, f);",
  '  const first = fs.readFileSync(file, "utf8").split("\\n")[0];',
  '  const title = first.startsWith("// test: ") ? first.slice(9).trim() : f;',
  '  let status = "passed";',
  "  try { require(file); } catch { status = \"failed\"; }",
  "  testResults.push({ name: file, assertionResults: [{ fullName: title, title, status }] });",
  "}",
  "fs.writeFileSync(process.argv[2], JSON.stringify({ testResults }));",
  "",
].join("\n");

const TAGGED_TEST = `// test: [AC1] greets formally\n${GOOD_TEST}`;
const ISSUE: Issue = { source: "test-issue.md", number: 7, title: "Formal greeting", body: "Please add greetFormal." };

function setup(script: Record<string, ScriptedTurn[]>, policyYaml: string) {
  const root = makeRepo(policyYaml);
  fs.writeFileSync(path.join(root, "test", "report.cjs"), REPORT_SCRIPT);
  gitIn(root, "add", "-A");
  gitIn(root, "commit", "-q", "-m", "add report script");
  const llm = new ScriptedLlm({ ...planTurns(), ...script });
  const ctx = createContext({ root, llm, runId: "run-trace" });
  return { root, llm, ctx };
}

const gate = new DecidedGate(humanApproval("ankita"));

describe("trace: in the pipeline", () => {
  it("report mode: shows an untested criterion without blocking the change", async () => {
    const { ctx } = setup(
      { submit_implementation: implementCorrectly(), submit_review: [[call("submit_review", APPROVE)]] },
      TRACE_YAML("report"),
    );
    const result = await runPipeline(ctx, ISSUE, gate);

    expect(result.status).toBe("ready_for_human_review");
    const traceability = result.rounds[0]!.verification!.traceability!;
    expect(traceability.matrix!.criteria[0]).toMatchObject({ id: "AC1", status: "untested" });
    expect(traceability.gaps).toEqual(["AC1 has no passing test tagged [AC1]"]);

    const report = fs.readFileSync(result.report_path, "utf8");
    expect(report).toContain("| Id | Criterion | Tests (run by the pipeline) | Reviewer agent |");
    expect(report).toContain("## Traceability");
    expect(report).toContain("Gaps (reported only under this policy):");

    // The report file is written outside the workspace, so it is not part of the change.
    expect(result.rounds[0]!.verification!.changed_files.sort()).toEqual(["src/greet.cjs", "test/formal.test.cjs"]);
  });

  it("required mode: sends untraced work back, then accepts it once the test is tagged", async () => {
    const { llm, ctx } = setup(
      {
        submit_implementation: [
          ...implementCorrectly(), // round 1: correct code, but the test carries no criterion tag
          [call("write_file", { path: "test/formal.test.cjs", content: TAGGED_TEST })],
          [call("run_tests")],
          [call("submit_implementation", IMPLEMENTATION)],
        ],
        submit_review: [[call("submit_review", APPROVE)]],
      },
      TRACE_YAML("required"),
    );
    const result = await runPipeline(ctx, ISSUE, gate);

    expect(result.status).toBe("ready_for_human_review");
    expect(result.rounds).toHaveLength(2);
    expect(result.rounds[0]!.verification).toMatchObject({ passed: false, tests: { passed: true }, policy_violations: [] });
    expect(result.rounds[0]!.review).toBeUndefined(); // untraced work is never sent to review
    expect(result.rounds[1]!.verification!.traceability!.matrix!.criteria[0]).toMatchObject({
      status: "verified",
      tests: [{ file: "test/formal.test.cjs", name: "[AC1] greets formally", status: "passed" }],
    });

    const implementerCalls = llm.requests.filter((r) => r.tools.some((tool) => tool.name === "submit_implementation"));
    expect(JSON.stringify(implementerCalls[4]!.messages[0])).toContain(
      "The pipeline could not trace every acceptance criterion to a passing test",
    );

    const evidence = JSON.parse(fs.readFileSync(path.join(ctx.runDir, "trace.json"), "utf8"));
    expect(evidence).toMatchObject({
      run_id: "run-trace",
      commit: result.commit,
      plan_approved_by: "ankita",
      enforce: "required",
      gaps: [],
    });
    expect(evidence.spec_sha256).toMatch(/^[0-9a-f]{64}$/);

    const auditFile = path.join(ctx.runDir, "audit.jsonl");
    expect(verifyAuditLog(auditFile).ok).toBe(true);
    const traced = readAuditLog(auditFile).filter((e) => e.type === "traceability");
    expect(traced.map((e) => (e.data.gaps as string[]).length)).toEqual([1, 0]);
  });

  it("required mode: fails closed when the report command writes no report", async () => {
    const { ctx } = setup(
      { submit_implementation: implementCorrectly() },
      TRACE_YAML("required", "node -e 0 {report}").replace("max_rework_rounds: 1", "max_rework_rounds: 0"),
    );
    const result = await runPipeline(ctx, ISSUE, gate);

    expect(result.status).toBe("failed_verification");
    expect(result.detail).toContain("Traceability: the per-test report could not be read");
    expect(result.commit).toBeUndefined();
  });
});
