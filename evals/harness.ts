import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readIssueFile } from "../src/github.js";
import type { LlmClient } from "../src/llm/client.js";
import { call, ScriptedLlm, type ScriptedTurn } from "../src/llm/scripted.js";
import { createContext, runPipeline } from "../src/pipeline/pipeline.js";
import type { Issue, RunStatus } from "../src/types.js";

/**
 * Evaluation harness.
 *
 * Each task is an issue for the sample service plus a set of acceptance tests
 * the agents never see. The harness copies the service into a scratch git
 * repository, runs the whole pipeline on the issue, then drops the hidden
 * tests in and runs the suite. That separates two questions:
 *
 *   - did the pipeline finish and call the change "ready for human review"?
 *   - is the change actually correct?
 *
 * A run that is "ready" but fails the hidden tests is an escaped defect: the
 * pipeline's own verification and review were satisfied by wrong code. That
 * is the number to watch before trusting agents with more.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const SERVICE_DIR = path.join(REPO_ROOT, "examples", "sample-service");
const TASKS_DIR = path.join(REPO_ROOT, "evals", "tasks");
const WORKSPACES_DIR = path.join(REPO_ROOT, ".eval-workspaces");

export interface EvalTask {
  id: string;
  dir: string;
  issue: Issue;
}

export interface EvalOutcome {
  task: string;
  pipeline_status: RunStatus;
  /** Hidden acceptance tests (plus the full existing suite) pass on the agents' final change. */
  accepted: boolean;
  /** The pipeline said "ready" and the hidden tests agree. */
  success: boolean;
  /** The pipeline said "ready" but the hidden tests fail. */
  escaped_defect: boolean;
  rounds: number;
  model_calls: number;
  tool_calls: number;
  policy_denials: number;
  total_tokens: number;
  cost_usd: number;
  duration_s: number;
  detail: string;
}

export function loadTasks(only?: string[]): EvalTask[] {
  return fs
    .readdirSync(TASKS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (!only?.length || only.includes(entry.name)))
    .map((entry) => {
      const dir = path.join(TASKS_DIR, entry.name);
      return { id: entry.name, dir, issue: { ...readIssueFile(path.join(dir, "issue.md")), source: `evals/tasks/${entry.name}` } };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function listFiles(dir: string, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full).split(path.sep).join("/")];
  });
}

/** A fresh git repository containing a copy of the sample service. */
export function createWorkspace(taskId: string): string {
  const dir = path.join(WORKSPACES_DIR, `${taskId}-${Date.now().toString(36)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.cpSync(SERVICE_DIR, dir, {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.agent-runs|coverage)([\\/]|$)/.test(src),
  });
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdio: "pipe",
    });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "baseline");
  return dir;
}

/**
 * Offline mode: a scripted "model" that writes the task's reference solution.
 * It proves the harness and the hidden tests are sound (the reference passes,
 * the pipeline accepts it) without calling the API. It does not measure
 * anything about a real model.
 */
export function referenceLlm(task: EvalTask): ScriptedLlm {
  const referenceDir = path.join(task.dir, "reference");
  const files = listFiles(referenceDir);
  const writes: ScriptedTurn[] = files.map((rel) => [
    call("write_file", { path: rel, content: fs.readFileSync(path.join(referenceDir, rel), "utf8") }),
  ]);
  const criteria = [{ id: "AC1", text: "The behaviour described in the issue is implemented and tested." }];
  return new ScriptedLlm({
    submit_spec: [
      [call("list_files")],
      [
        call("submit_spec", {
          title: task.issue.title,
          problem: "See the issue.",
          acceptance_criteria: criteria,
          out_of_scope: [],
          open_questions: [],
          risk: "low",
          risk_rationale: "Small change to one module of the sample service.",
        }),
      ],
    ],
    submit_plan: [
      [
        call("submit_plan", {
          summary: "Apply the reference solution for this task.",
          steps: [{ id: "1", description: "Write the reference files.", files, covers: ["AC1"] }],
          test_strategy: "The reference tests plus the existing suite.",
        }),
      ],
    ],
    submit_implementation: [
      ...writes,
      [call("run_tests")],
      [
        call("submit_implementation", {
          summary: "Applied the reference solution.",
          criteria_status: [{ id: "AC1", status: "met", evidence: "reference tests" }],
          tests_passing: true,
          notes: "",
        }),
      ],
    ],
    submit_review: [
      [
        call("submit_review", {
          decision: "approve",
          summary: "Reference solution.",
          findings: [],
          criteria_check: [{ id: "AC1", met: true, note: "" }],
        }),
      ],
    ],
  });
}

function runAcceptance(task: EvalTask, workspace: string): { passed: boolean; output: string } {
  fs.copyFileSync(path.join(task.dir, "acceptance.test.ts"), path.join(workspace, "test", "acceptance.test.ts"));
  const run = spawnSync("npx", ["vitest", "run"], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    timeout: 180_000,
  });
  return { passed: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.slice(-3000) };
}

export async function runTask(task: EvalTask, llm: LlmClient, log: (line: string) => void = () => {}): Promise<EvalOutcome> {
  const started = Date.now();
  const workspace = createWorkspace(task.id);
  const ctx = createContext({ root: workspace, llm, log });

  let status: RunStatus = "error";
  let rounds = 0;
  let detail = "";
  try {
    // The sample service's policy sets the plan gate to `auto`; evals run unattended.
    const result = await runPipeline(ctx, task.issue, {
      requestPlanApproval: () => Promise.reject(new Error("eval tasks must not need interactive approval")),
    });
    status = result.status;
    rounds = result.rounds.length;
    detail = result.detail;
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }

  const acceptance = runAcceptance(task, workspace);
  const ready = status === "ready_for_human_review";
  if (ready && !acceptance.passed) detail = `Escaped defect. Hidden tests failed:\n${acceptance.output}`;

  const usage = ctx.usage.total();
  return {
    task: task.id,
    pipeline_status: status,
    accepted: acceptance.passed,
    success: ready && acceptance.passed,
    escaped_defect: ready && !acceptance.passed,
    rounds,
    model_calls: usage.calls,
    tool_calls: ctx.audit.count("tool_call"),
    policy_denials: ctx.audit.count("policy_decision", (e) => e.data.allowed === false),
    total_tokens: ctx.usage.totalTokens(),
    cost_usd: Number(usage.cost_usd.toFixed(4)),
    duration_s: Math.round((Date.now() - started) / 1000),
    detail,
  };
}

export function renderResults(outcomes: EvalOutcome[], mode: string, model: string): string {
  const n = outcomes.length;
  const successes = outcomes.filter((o) => o.success).length;
  const escaped = outcomes.filter((o) => o.escaped_defect).length;
  const cost = outcomes.reduce((sum, o) => sum + o.cost_usd, 0);
  const lines = [
    `## Eval results (${mode})`,
    "",
    `Model: \`${model}\` · Tasks: ${n} · **Success: ${successes}/${n}** · Escaped defects: ${escaped} · Total cost: $${cost.toFixed(2)}`,
    "",
    "| Task | Pipeline outcome | Hidden tests | Rounds | Model calls | Tool calls | Policy denials | Tokens | Cost | Time |",
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ...outcomes.map(
      (o) =>
        `| ${o.task} | ${o.pipeline_status} | ${o.accepted ? "pass" : "**fail**"} | ${o.rounds} | ${o.model_calls} | ${o.tool_calls} | ${o.policy_denials} | ${o.total_tokens.toLocaleString("en-US")} | $${o.cost_usd.toFixed(2)} | ${o.duration_s}s |`,
    ),
    "",
    "_Success = the pipeline reported the change ready for human review **and** the hidden acceptance tests pass. " +
      "An escaped defect is a change the pipeline called ready that the hidden tests reject._",
  ];
  return lines.join("\n");
}
