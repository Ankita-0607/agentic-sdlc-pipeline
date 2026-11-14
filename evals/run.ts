import fs from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL } from "../src/config.js";
import { AnthropicLlm } from "../src/llm/client.js";
import { SCRIPTED_MODEL } from "../src/llm/scripted.js";
import { loadTasks, referenceLlm, renderResults, runTask, type EvalOutcome } from "./harness.js";

/**
 * npm run eval            live: real model, needs ANTHROPIC_API_KEY, costs money
 * npm run eval:offline    scripted reference solutions, free, used in CI
 * npm run eval -- --task sla-breaches   run a subset
 */
const args = process.argv.slice(2);
const offline = args.includes("--offline");
const only = args.flatMap((arg, i) => (arg === "--task" && args[i + 1] ? [args[i + 1]!] : []));

const tasks = loadTasks(only);
if (tasks.length === 0) {
  console.error("No matching eval tasks.");
  process.exit(1);
}

const outcomes: EvalOutcome[] = [];
for (const task of tasks) {
  console.error(`\n=== ${task.id} ===`);
  const llm = offline ? referenceLlm(task) : new AnthropicLlm();
  outcomes.push(await runTask(task, llm, (line) => console.error(`  ${line}`)));
}

const mode = offline ? "offline, scripted reference solutions" : "live";
const model = offline ? SCRIPTED_MODEL : DEFAULT_MODEL;
const markdown = renderResults(outcomes, mode, model);
console.log(`\n${markdown}`);

const resultsDir = path.resolve(import.meta.dirname, "results");
fs.mkdirSync(resultsDir, { recursive: true });
const stem = offline ? "offline" : "live";
fs.writeFileSync(
  path.join(resultsDir, `${stem}.json`),
  JSON.stringify({ mode: stem, model, ran_at: new Date().toISOString(), outcomes }, null, 2) + "\n",
);
fs.writeFileSync(path.join(resultsDir, `${stem}.md`), markdown + "\n");
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown + "\n");

// Offline mode is a CI gate: the reference solutions must be accepted.
// Live mode reports model results and does not fail the job on a miss.
if (offline && outcomes.some((o) => !o.success)) {
  for (const o of outcomes.filter((x) => !x.success)) console.error(`\n${o.task}: ${o.detail}`);
  process.exit(1);
}
