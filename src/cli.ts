#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { verifyAuditLog } from "./audit/audit.js";
import {
  encodeState,
  fetchIssue,
  findPlanState,
  openPullRequest,
  postIssueComment,
  readIssueFile,
  setActionOutputs,
} from "./github.js";
import { AnthropicLlm } from "./llm/client.js";
import { humanApproval, InteractiveGate } from "./pipeline/gates.js";
import { buildPhase, createContext, planPhase, runPipeline } from "./pipeline/pipeline.js";
import { renderPlanMarkdown } from "./pipeline/report.js";
import { loadPolicy, PolicyEngine } from "./policy/policy.js";
import { buildTrace, parseTestReport, renderTraceMarkdown, traceGaps } from "./trace/trace.js";
import { PlanStateSchema, type Issue, type RunResult } from "./types.js";

const program = new Command()
  .name("asdlc")
  .description("Governed agentic SDLC pipeline: issue → spec → plan → code → tests → review → pull request");

const log = (line: string) => process.stderr.write(line + "\n");

function resolveRepo(option: string | undefined): string {
  const repo = option ?? process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("pass --repo owner/name (or set GITHUB_REPOSITORY)");
  return repo;
}

function loadIssue(ref: string, repoOption: string | undefined): Issue {
  if (/^#?\d+$/.test(ref)) return fetchIssue(resolveRepo(repoOption), Number(ref.replace("#", "")));
  return readIssueFile(ref);
}

function exitCode(result: RunResult): number {
  return result.status === "ready_for_human_review" ? 0 : 2;
}

program
  .command("plan")
  .description("Phase 1: read the issue, write a spec and an implementation plan. Changes no code.")
  .requiredOption("--issue <ref>", "path to a Markdown issue file, or a GitHub issue number")
  .option("--dir <path>", "target repository checkout", ".")
  .option("--repo <owner/name>", "GitHub repository (for issue numbers and --post)")
  .option("--post", "post the plan as a comment on the GitHub issue", false)
  .action(async (opts: { issue: string; dir: string; repo?: string; post: boolean }) => {
    const issue = loadIssue(opts.issue, opts.repo);
    const ctx = createContext({ root: opts.dir, llm: new AnthropicLlm(), log });
    const state = await planPhase(ctx, issue);
    const markdown = renderPlanMarkdown(state);
    process.stdout.write(markdown + "\n");
    log(`\nPlan state saved to ${path.join(ctx.runDir, "state.json")}`);

    if (opts.post) {
      if (!issue.number) throw new Error("--post needs a GitHub issue number");
      const cost = ctx.usage.total().cost_usd.toFixed(3);
      postIssueComment(
        resolveRepo(opts.repo),
        issue.number,
        [
          markdown,
          "",
          "---",
          `Planning cost so far: about $${cost}. No code has been written.`,
          "A maintainer can comment `/approve` to let the agents implement this plan and open a pull request.",
          encodeState(state),
        ].join("\n"),
      );
    }
    setActionOutputs({ run_dir: ctx.runDir, run_id: ctx.runId });
  });

program
  .command("build")
  .description("Phase 2: implement an approved plan, verify it, have it reviewed, and commit it on a branch.")
  .requiredOption("--approved-by <name>", "the human who approved the plan (recorded in the audit log)")
  .option("--state <file>", "state.json written by `asdlc plan`")
  .option("--issue <number>", "GitHub issue to resume from (reads the plan comment)")
  .option("--dir <path>", "target repository checkout", ".")
  .option("--repo <owner/name>", "GitHub repository")
  .option("--open-pr", "push the branch and open a pull request", false)
  .option("--base <branch>", "base branch for the pull request", "main")
  .action(
    async (opts: {
      approvedBy: string;
      state?: string;
      issue?: string;
      dir: string;
      repo?: string;
      openPr: boolean;
      base: string;
    }) => {
      const state = opts.state
        ? PlanStateSchema.parse(JSON.parse(fs.readFileSync(opts.state, "utf8")))
        : opts.issue
          ? findPlanState(resolveRepo(opts.repo), Number(opts.issue))
          : null;
      if (!state) throw new Error("no plan found: pass --state <file>, or --issue <number> with a posted plan");

      // Resume in the plan phase's run directory when it exists, so the audit chain continues.
      const runDir = opts.state ? path.dirname(path.resolve(opts.state)) : undefined;
      const ctx = createContext({ root: opts.dir, llm: new AnthropicLlm(), runId: state.run_id, runDir, log });
      const result = await buildPhase(ctx, state, humanApproval(opts.approvedBy));

      let prUrl = "";
      if (opts.openPr && result.status === "ready_for_human_review" && result.branch) {
        const repo = resolveRepo(opts.repo);
        ctx.workspace.push(result.branch);
        prUrl = openPullRequest({
          repo,
          branch: result.branch,
          base: opts.base,
          title: state.spec.title,
          bodyFile: result.report_path,
        });
        log(`Pull request opened: ${prUrl}`);
      }
      const ready = result.status === "ready_for_human_review";
      if (opts.repo && state.issue.number) {
        if (ready && prUrl) {
          postIssueComment(
            resolveRepo(opts.repo),
            state.issue.number,
            `The agents implemented the approved plan: ${prUrl}\n\nA human needs to review and merge it.`,
          );
        } else if (!ready) {
          // Tell the humans on the issue why there is no pull request.
          postIssueComment(resolveRepo(opts.repo), state.issue.number, fs.readFileSync(result.report_path, "utf8"));
        }
      }
      setActionOutputs({
        status: result.status,
        run_dir: ctx.runDir,
        branch: result.branch ?? "",
        report_path: result.report_path,
        title: state.spec.title,
        pr_url: prUrl,
      });
      process.stdout.write(fs.readFileSync(result.report_path, "utf8"));
      process.exitCode = exitCode(result);
    },
  );

program
  .command("run")
  .description("Both phases in one go, asking for plan approval on the terminal.")
  .requiredOption("--issue <ref>", "path to a Markdown issue file, or a GitHub issue number")
  .option("--dir <path>", "target repository checkout", ".")
  .option("--repo <owner/name>", "GitHub repository (for issue numbers)")
  .action(async (opts: { issue: string; dir: string; repo?: string }) => {
    const issue = loadIssue(opts.issue, opts.repo);
    const ctx = createContext({ root: opts.dir, llm: new AnthropicLlm(), log });
    const result = await runPipeline(ctx, issue, new InteractiveGate(os.userInfo().username));
    process.stdout.write(fs.readFileSync(result.report_path, "utf8"));
    log(`\nRun artifacts: ${ctx.runDir}`);
    process.exitCode = exitCode(result);
  });

const audit = program.command("audit").description("Work with audit logs");
audit
  .command("verify <file>")
  .description("Check the hash chain of an audit log")
  .action((file: string) => {
    const result = verifyAuditLog(file);
    if (result.ok) {
      process.stdout.write(`OK: ${result.events} events, hash chain intact\n`);
    } else {
      process.stdout.write(`TAMPERED: ${result.reason} at event ${result.broken_at} (of ${result.events})\n`);
      process.exitCode = 1;
    }
  });

program
  .command("trace")
  .description("Match a Jest/Vitest JSON test report to the acceptance criteria of a spec. Calls no model.")
  .requiredOption("--state <file>", "state.json written by `asdlc plan` (the approved spec)")
  .requiredOption("--report <file>", "JSON test report, e.g. from `vitest run --reporter=json --outputFile=report.json`")
  .option("--dir <path>", "repository checkout, used to shorten test file paths", ".")
  .option("--strict", "exit with status 1 when a criterion has no passing tagged test", false)
  .action((opts: { state: string; report: string; dir: string; strict: boolean }) => {
    const state = PlanStateSchema.parse(JSON.parse(fs.readFileSync(opts.state, "utf8")));
    const tests = parseTestReport(JSON.parse(fs.readFileSync(opts.report, "utf8")), fs.realpathSync(path.resolve(opts.dir)));
    const matrix = buildTrace(state.spec, tests);
    const gaps = traceGaps(matrix);
    process.stdout.write(`## Traceability: ${state.spec.title}\n\n${renderTraceMarkdown(matrix)}\n`);
    if (gaps.length > 0) {
      process.stdout.write(`\nGaps:\n${gaps.map((g) => `- ${g}`).join("\n")}\n`);
      if (opts.strict) process.exitCode = 1;
    }
  });

const policy = program.command("policy").description("Work with the repository policy");
policy
  .command("check")
  .description("Validate agent-policy.yaml")
  .option("--dir <path>", "target repository checkout", ".")
  .action((opts: { dir: string }) => {
    const loaded = loadPolicy(opts.dir);
    process.stdout.write(
      `agent-policy.yaml is valid\n` +
        `  writable:  ${loaded.workspace.writable.join(", ")}\n` +
        `  protected: ${loaded.workspace.protected.join(", ") || "(none)"}\n` +
        `  plan approval: ${loaded.gates.plan_approval}\n` +
        `  traceability: ${loaded.traceability ? loaded.traceability.enforce : "off"}\n` +
        `  budget: $${loaded.budget.max_cost_usd} / ${loaded.budget.max_total_tokens} tokens\n`,
    );
  });

policy
  .command("check-patch <file>")
  .description("Check the files a patch touches against the policy, without applying it")
  .option("--dir <path>", "target repository checkout", ".")
  .action((file: string, opts: { dir: string }) => {
    const engine = new PolicyEngine(loadPolicy(opts.dir), opts.dir);
    const numstat = execFileSync("git", ["apply", "--numstat", path.resolve(file)], { cwd: opts.dir, encoding: "utf8" });
    const rows = numstat.split("\n").filter((line) => line.trim().length > 0).map((line) => line.split("\t"));
    const changed = rows.map((cols) => ({ path: cols.slice(2).join("\t"), status: "M" }));
    const lines = rows.reduce((sum, cols) => sum + (Number(cols[0]) || 0) + (Number(cols[1]) || 0), 0);
    const violations = engine.checkChangeSet(changed, lines);
    if (violations.length > 0) {
      process.stdout.write(`Patch violates policy:\n${violations.map((v) => `  - ${v}`).join("\n")}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`Patch is within policy: ${changed.length} files, ${lines} changed lines\n`);
    }
  });

program.parseAsync().catch((err: unknown) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
