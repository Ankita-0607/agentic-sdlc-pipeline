import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AuditLog } from "../src/audit/audit.js";
import type { AgentRuntime } from "../src/agent/loop.js";
import { call, ScriptedLlm, type ScriptedTurn } from "../src/llm/scripted.js";
import { UsageTracker } from "../src/llm/usage.js";
import { parsePolicy, PolicyEngine, type Policy } from "../src/policy/policy.js";
import type { Implementation, Plan, Review, Spec } from "../src/types.js";

export const POLICY_YAML = `
version: 1
workspace:
  writable: ["src/**", "test/**"]
  protected: ["src/generated/**", "package.json"]
  unreadable: ["**/.env*", "secrets/**"]
limits:
  max_files_changed: 3
  max_file_bytes: 2000
  max_diff_lines: 200
  max_rework_rounds: 1
  max_turns_per_agent: 8
budget:
  max_cost_usd: 1
  max_total_tokens: 1000000
commands:
  test: "node test/run.cjs"
  timeout_seconds: 30
gates:
  plan_approval: required
roles:
  spec: [list_files, read_file, search_code]
  planner: [list_files, read_file, search_code]
  implementer: [list_files, read_file, search_code, write_file, edit_file, run_tests]
  reviewer: [list_files, read_file, search_code, run_tests]
`;

export function policyWith(mutate: (p: Policy) => void = () => {}): Policy {
  const policy = parsePolicy(POLICY_YAML);
  mutate(policy);
  return policy;
}

export function tempDir(prefix = "asdlc-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  });

/**
 * A tiny git repository to run the pipeline against: one module, one test
 * script (plain Node, so it runs in milliseconds), and a policy file.
 */
export function makeRepo(policyYaml = POLICY_YAML): string {
  const root = tempDir("asdlc-repo-");
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  write("agent-policy.yaml", policyYaml);
  write("package.json", '{ "name": "fixture", "private": true }\n');
  write("src/greet.cjs", 'exports.greet = (name) => "Hello, " + name;\n');
  write(
    "test/run.cjs",
    [
      'const assert = require("node:assert");',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const { greet } = require("../src/greet.cjs");',
      'assert.strictEqual(greet("Ada"), "Hello, Ada");',
      "// Run any extra test files the implementer added.",
      "for (const f of fs.readdirSync(__dirname)) {",
      '  if (f.endsWith(".test.cjs")) require(path.join(__dirname, f));',
      "}",
      'console.log("all tests passed");',
      "",
    ].join("\n"),
  );
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "initial");
  return root;
}

export const gitIn = git;

export function makeRuntime(root: string, llm: ScriptedLlm, policy = policyWith()): AgentRuntime & { auditFile: string } {
  const auditFile = path.join(tempDir("asdlc-audit-"), "audit.jsonl");
  return {
    llm,
    policy: new PolicyEngine(policy, root),
    audit: new AuditLog(auditFile, "test-run"),
    usage: new UsageTracker(),
    changed: new Set<string>(),
    model: "claude-opus-5-5",
    auditFile,
  };
}

export const SPEC: Spec = {
  title: "Greet politely",
  problem: "greet() does not support a formal greeting.",
  acceptance_criteria: [{ id: "AC1", text: 'greetFormal("Ada") returns "Good day, Ada".' }],
  out_of_scope: [],
  open_questions: [],
  risk: "low",
  risk_rationale: "Isolated addition.",
};

export const PLAN: Plan = {
  summary: "Add greetFormal next to greet and test it.",
  steps: [{ id: "1", description: "Add greetFormal", files: ["src/greet.cjs", "test/formal.test.cjs"], covers: ["AC1"] }],
  test_strategy: "A new test file asserts the formal greeting.",
};

export const IMPLEMENTATION: Implementation = {
  summary: "Added greetFormal and a test.",
  criteria_status: [{ id: "AC1", status: "met", evidence: "test/formal.test.cjs" }],
  tests_passing: true,
  notes: "",
};

export const APPROVE: Review = {
  decision: "approve",
  summary: "Meets the spec.",
  findings: [],
  criteria_check: [{ id: "AC1", met: true, note: "covered by test" }],
};

export const REQUEST_CHANGES: Review = {
  decision: "request_changes",
  summary: "Missing edge case.",
  findings: [{ severity: "major", file: "src/greet.cjs", comment: "Empty name is not handled." }],
  criteria_check: [{ id: "AC1", met: true, note: "" }],
};

export const GOOD_SOURCE =
  'exports.greet = (name) => "Hello, " + name;\nexports.greetFormal = (name) => "Good day, " + name;\n';
export const GOOD_TEST =
  'const assert = require("node:assert");\nconst { greetFormal } = require("../src/greet.cjs");\nassert.strictEqual(greetFormal("Ada"), "Good day, Ada");\n';

/** The implementer turns for a correct change: write source, write test, run tests, submit. */
export const implementCorrectly = (): ScriptedTurn[] => [
  [call("write_file", { path: "src/greet.cjs", content: GOOD_SOURCE })],
  [call("write_file", { path: "test/formal.test.cjs", content: GOOD_TEST })],
  [call("run_tests")],
  [call("submit_implementation", IMPLEMENTATION)],
];

export const planTurns = (): Record<string, ScriptedTurn[]> => ({
  submit_spec: [[call("list_files")], [call("submit_spec", SPEC)]],
  submit_plan: [[call("read_file", { path: "src/greet.cjs" })], [call("submit_plan", PLAN)]],
});

export { call, ScriptedLlm, type ScriptedTurn };
