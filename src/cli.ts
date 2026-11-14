#!/usr/bin/env node
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
import { loadPolicy } from "./policy/policy.js";
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
      if (opts.repo && state.issue.number) {
        const body =
          result.status === "ready_for_human_review" && prUrl
            ? `The agents implemented the approved plan: ${prUrl}\n\nA human needs to review and merge it.`
            : fs.readFileSync(result.report_path, "utf8");
        postIssueComment(resolveRepo(opts.repo), state.issue.number, body);
      }
      setActionOutputs({ status: result.status, run_dir: ctx.runDir, branch: result.branch ?? "", pr_url: prUrl });
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
        `  budget: $${loaded.budget.max_cost_usd} / ${loaded.budget.max_total_tokens} tokens\n`,
    );
  });

program.parseAsync().catch((err: unknown) => {
  log(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
