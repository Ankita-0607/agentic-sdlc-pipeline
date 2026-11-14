import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PlanStateSchema, type Issue, type PlanState } from "./types.js";

/**
 * GitHub integration through the `gh` CLI (present on GitHub-hosted runners,
 * authenticated by GH_TOKEN). Arguments are passed as an array, never through
 * a shell.
 */

const STATE_MARKER = "asdlc:plan-state:";
/** Only plan-state comments written by this account are trusted when resuming a run. */
const TRUSTED_STATE_AUTHOR = process.env.ASDLC_STATE_AUTHOR ?? "github-actions[bot]";

function gh(args: string[], input?: string): string {
  return execFileSync("gh", args, { encoding: "utf8", input, maxBuffer: 16 * 1024 * 1024 });
}

export function fetchIssue(repo: string, number: number): Issue {
  const raw = JSON.parse(gh(["api", `repos/${repo}/issues/${number}`])) as { title: string; body: string | null };
  return { source: `${repo}#${number}`, number, title: raw.title, body: raw.body ?? "" };
}

export function readIssueFile(file: string): Issue {
  const text = fs.readFileSync(file, "utf8");
  const heading = text.match(/^#\s+(.+)$/m);
  const title = heading?.[1]?.trim() ?? path.basename(file, path.extname(file));
  const body = heading ? text.replace(heading[0], "").trim() : text.trim();
  return { source: file, title, body };
}

export function postIssueComment(repo: string, number: number, body: string): void {
  gh(["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", "-"], JSON.stringify({ body }));
}

/** The plan state travels between the two workflow runs inside the plan comment itself. */
export function encodeState(state: PlanState): string {
  return `<!-- ${STATE_MARKER}${Buffer.from(JSON.stringify(state), "utf8").toString("base64")} -->`;
}

export function decodeState(commentBody: string): PlanState | null {
  const match = commentBody.match(new RegExp(`<!-- ${STATE_MARKER}([A-Za-z0-9+/=]+) -->`));
  if (!match?.[1]) return null;
  try {
    const parsed = PlanStateSchema.safeParse(JSON.parse(Buffer.from(match[1], "base64").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Find the most recent plan posted on the issue. Comments from any other
 * author are ignored, so a commenter cannot hand the build phase a forged
 * "approved plan".
 */
export function findPlanState(repo: string, number: number): PlanState | null {
  const comments = JSON.parse(
    gh(["api", `repos/${repo}/issues/${number}/comments?per_page=100`]),
  ) as Array<{ body: string; user: { login: string } }>;
  for (const comment of comments.reverse()) {
    if (comment.user.login !== TRUSTED_STATE_AUTHOR) continue;
    const state = decodeState(comment.body);
    if (state) return state;
  }
  return null;
}

export function openPullRequest(options: {
  repo: string;
  branch: string;
  base: string;
  title: string;
  bodyFile: string;
}): string {
  return gh([
    "pr",
    "create",
    "--repo",
    options.repo,
    "--head",
    options.branch,
    "--base",
    options.base,
    "--title",
    options.title,
    "--body-file",
    options.bodyFile,
  ]).trim();
}

/** Expose step outputs to the workflow when running inside GitHub Actions. */
export function setActionOutputs(outputs: Record<string, string>): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  fs.appendFileSync(file, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(""));
}
