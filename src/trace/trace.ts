import path from "node:path";
import { z } from "zod";
import type { Spec } from "../types.js";

/**
 * Criterion-to-test traceability.
 *
 * The reviewer agent's "met / not met" is a model's opinion. This module adds
 * a deterministic answer to a narrower question: for each acceptance
 * criterion in the approved spec, which tests claim to prove it, and did those
 * tests pass when the pipeline ran them?
 *
 * A test claims a criterion by carrying its id in square brackets in the test
 * name, e.g. `it("[AC1] excludes time on hold")`. Nothing here calls a model.
 *
 * What this does not show: that a tagged test really checks the behaviour the
 * criterion describes. The tag is the author's claim; the reviewer agent and
 * the human reviewer are the controls for that.
 */

export type TestStatus = "passed" | "failed" | "skipped";

export interface TestOutcome {
  /** Path relative to the repository root when the file is inside it. */
  file: string;
  name: string;
  status: TestStatus;
}

/**
 * `verified`: at least one tagged test passed and none failed.
 * `failing`:  at least one tagged test failed.
 * `untested`: no tagged test ran (skipped tests do not count as evidence).
 */
export type CriterionStatus = "verified" | "failing" | "untested";

export interface CriterionTrace {
  id: string;
  text: string;
  status: CriterionStatus;
  tests: TestOutcome[];
}

export interface TraceMatrix {
  criteria: CriterionTrace[];
  /** Tags that look like criterion ids but are not in the spec, e.g. `[AC9]` when the spec stops at AC3. */
  unknown_ids: string[];
  total_tests: number;
  /** Tests that carry no criterion tag. Informational: existing suites are mostly untagged. */
  untagged_tests: number;
}

/**
 * The subset of the Jest JSON report format this module reads. Vitest
 * (`--reporter=json`) and Jest (`--json`) both produce it.
 */
const TestReportSchema = z.object({
  testResults: z.array(
    z.object({
      name: z.string(),
      assertionResults: z.array(
        z.object({
          fullName: z.string().optional(),
          title: z.string().optional(),
          status: z.string(),
        }),
      ),
    }),
  ),
});

function normaliseStatus(status: string): TestStatus {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  return "skipped"; // pending, skipped, todo, disabled
}

/** Parse a Jest/Vitest JSON report into a flat list of test outcomes. Throws on an unrecognised shape. */
export function parseTestReport(json: unknown, root?: string): TestOutcome[] {
  const report = TestReportSchema.parse(json);
  const outcomes: TestOutcome[] = [];
  for (const file of report.testResults) {
    let name = file.name;
    if (root) {
      const rel = path.relative(root, file.name);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) name = rel;
    }
    name = name.split(path.sep).join("/");
    for (const assertion of file.assertionResults) {
      outcomes.push({
        file: name,
        name: (assertion.fullName ?? assertion.title ?? "").trim() || "(unnamed test)",
        status: normaliseStatus(assertion.status),
      });
    }
  }
  return outcomes;
}

const BRACKET_GROUP = /\[([^\[\]]+)\]/g;
const ID_SHAPE = /^([A-Za-z]+)[-_]?\d+$/;

/** Every bracketed token in a test name: "[AC1, AC2] foo [slow]" -> ["AC1", "AC2", "slow"]. */
export function bracketTokens(testName: string): string[] {
  const tokens: string[] = [];
  for (const match of testName.matchAll(BRACKET_GROUP)) {
    for (const token of match[1]!.split(",")) {
      const trimmed = token.trim();
      if (trimmed) tokens.push(trimmed);
    }
  }
  return tokens;
}

/** Match tests to the spec's acceptance criteria by the ids tagged in test names. Ids compare case-insensitively. */
export function buildTrace(spec: Spec, tests: TestOutcome[]): TraceMatrix {
  const byId = new Map<string, CriterionTrace>();
  const prefixes = new Set<string>();
  for (const criterion of spec.acceptance_criteria) {
    byId.set(criterion.id.toLowerCase(), { id: criterion.id, text: criterion.text, status: "untested", tests: [] });
    const shape = ID_SHAPE.exec(criterion.id);
    if (shape) prefixes.add(shape[1]!.toLowerCase());
  }

  const unknown = new Set<string>();
  let untagged = 0;
  for (const test of tests) {
    let tagged = false;
    for (const token of new Set(bracketTokens(test.name).map((t) => t.toLowerCase()))) {
      const criterion = byId.get(token);
      if (criterion) {
        criterion.tests.push(test);
        tagged = true;
        continue;
      }
      // Only tokens shaped like this spec's ids ("AC9") are reported, so "[slow]" or "[1, 2]" are ignored.
      const shape = ID_SHAPE.exec(token);
      if (shape && prefixes.has(shape[1]!.toLowerCase())) unknown.add(token.toUpperCase());
    }
    if (!tagged) untagged++;
  }

  for (const criterion of byId.values()) {
    if (criterion.tests.some((t) => t.status === "failed")) criterion.status = "failing";
    else if (criterion.tests.some((t) => t.status === "passed")) criterion.status = "verified";
  }

  return {
    criteria: [...byId.values()],
    unknown_ids: [...unknown].sort(),
    total_tests: tests.length,
    untagged_tests: untagged,
  };
}

/** One line per problem, worded so an implementer (human or agent) can act on it. Empty when every criterion is verified. */
export function traceGaps(matrix: TraceMatrix): string[] {
  const gaps: string[] = [];
  for (const criterion of matrix.criteria) {
    if (criterion.status === "untested") {
      const skipped = criterion.tests.length > 0 ? " (the tagged tests were skipped)" : "";
      gaps.push(`${criterion.id} has no passing test tagged [${criterion.id}]${skipped}`);
    } else if (criterion.status === "failing") {
      const failed = criterion.tests.filter((t) => t.status === "failed").map((t) => `"${t.name}"`);
      gaps.push(`${criterion.id} has failing tests: ${failed.join(", ")}`);
    }
  }
  for (const id of matrix.unknown_ids) {
    gaps.push(`a test is tagged [${id}], which is not an acceptance criterion in the spec`);
  }
  return gaps;
}

const STATUS_LABEL: Record<CriterionStatus, string> = {
  verified: "verified",
  failing: "**failing**",
  untested: "**untested**",
};

/** Short cell text for a criterion, e.g. "verified (2 tests)". */
export function describeCriterion(criterion: CriterionTrace): string {
  const counted = criterion.tests.filter((t) => t.status !== "skipped").length;
  if (criterion.status === "untested") return STATUS_LABEL.untested;
  return `${STATUS_LABEL[criterion.status]} (${counted} ${counted === 1 ? "test" : "tests"})`;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** The traceability matrix as a Markdown table, with a line of totals underneath. */
export function renderTraceMarkdown(matrix: TraceMatrix): string {
  const lines = ["| Id | Criterion | Status | Tests |", "|---|---|---|---|"];
  for (const criterion of matrix.criteria) {
    const tests =
      criterion.tests.length > 0
        ? criterion.tests.map((t) => `${t.status === "passed" ? "✓" : t.status === "failed" ? "✗" : "–"} ${cell(t.name)} (\`${t.file}\`)`).join("<br>")
        : "none";
    lines.push(`| ${criterion.id} | ${cell(criterion.text)} | ${STATUS_LABEL[criterion.status]} | ${tests} |`);
  }
  const verified = matrix.criteria.filter((c) => c.status === "verified").length;
  lines.push(
    "",
    `${verified} of ${matrix.criteria.length} criteria verified by passing tests. ` +
      `${matrix.total_tests} tests ran; ${matrix.untagged_tests} carry no criterion tag.`,
  );
  if (matrix.unknown_ids.length > 0) {
    lines.push(`Tags that match no criterion in the spec: ${matrix.unknown_ids.join(", ")}.`);
  }
  return lines.join("\n");
}
