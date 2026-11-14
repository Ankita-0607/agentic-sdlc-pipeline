import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkspace, loadTasks, runTask } from "../evals/harness.js";
import { call, ScriptedLlm } from "../src/llm/scripted.js";

const tasks = loadTasks();

describe("eval tasks", () => {
  it("has the expected task set", () => {
    expect(tasks.map((t) => t.id)).toEqual([
      "resume-from-hold",
      "sla-breaches",
      "tat-excludes-hold",
      "typed-transition-error",
    ]);
  });

  // The other half of soundness (the reference solution passes) is `npm run eval:offline` in CI.
  it.concurrent.each(tasks.map((t) => [t.id, t] as const))(
    "%s: the hidden tests fail on the unmodified service",
    async (_id, task) => {
      const workspace = createWorkspace(`${task.id}-baseline`);
      fs.copyFileSync(path.join(task.dir, "acceptance.test.ts"), path.join(workspace, "test", "acceptance.test.ts"));
      const run = spawnSync("npx", ["vitest", "run"], { cwd: workspace, encoding: "utf8" });
      expect(run.status).not.toBe(0);
    },
    60_000,
  );
});

describe("eval harness", () => {
  it("reports an escaped defect when the pipeline approves a change the hidden tests reject", async () => {
    const task = tasks.find((t) => t.id === "tat-excludes-hold")!;
    // The "implementation" only adds a comment: the existing tests still pass
    // and the scripted reviewer approves, but the behaviour is unchanged.
    const lazy = new ScriptedLlm({
      submit_spec: [
        [
          call("submit_spec", {
            title: task.issue.title,
            problem: "p",
            acceptance_criteria: [{ id: "AC1", text: "Holds are excluded." }],
            out_of_scope: [],
            open_questions: [],
            risk: "low",
            risk_rationale: "r",
          }),
        ],
      ],
      submit_plan: [
        [call("submit_plan", { summary: "s", steps: [{ id: "1", description: "d", files: ["src/turnaround.ts"], covers: ["AC1"] }], test_strategy: "t" })],
      ],
      submit_implementation: [
        [call("edit_file", { path: "src/turnaround.ts", old_text: "const MS_PER_HOUR", new_text: "// holds handled\nconst MS_PER_HOUR" })],
        [call("submit_implementation", { summary: "done", criteria_status: [], tests_passing: true, notes: "" })],
      ],
      submit_review: [[call("submit_review", { decision: "approve", summary: "lgtm", findings: [], criteria_check: [] })]],
    });

    const outcome = await runTask(task, lazy);
    expect(outcome).toMatchObject({
      pipeline_status: "ready_for_human_review",
      accepted: false,
      success: false,
      escaped_defect: true,
    });
  }, 60_000);
});
