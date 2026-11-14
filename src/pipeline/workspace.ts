import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Git operations on the target repository. Arguments are always passed as an
 * array (execFile, no shell), so branch names and paths derived from issue
 * text cannot be interpreted as shell syntax.
 */

const MAX_DIFF_CHARS = 60_000;

export class Workspace {
  constructor(readonly root: string) {}

  private git(args: string[]): string {
    return execFileSync("git", args, {
      cwd: this.root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  /**
   * Keep the pipeline's own run artifacts (audit log, plan, report) out of the
   * change set by ignoring them in this clone's .git/info/exclude. Nothing in
   * the repository itself is modified.
   */
  ignoreLocally(pattern: string): void {
    const excludeFile = path.resolve(this.root, this.git(["rev-parse", "--git-path", "info/exclude"]).trim());
    const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, "utf8") : "";
    if (current.split("\n").includes(pattern)) return;
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.appendFileSync(excludeFile, `${current.endsWith("\n") || current === "" ? "" : "\n"}${pattern}\n`);
  }

  headCommit(): string {
    return this.git(["rev-parse", "HEAD"]).trim();
  }

  currentBranch(): string {
    return this.git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  }

  isClean(): boolean {
    return this.git(["status", "--porcelain"]).trim().length === 0;
  }

  createBranch(name: string): void {
    this.git(["checkout", "-b", name]);
  }

  push(branch: string, remote = "origin"): void {
    this.git(["push", "-u", remote, branch]);
  }

  /** Stage everything, so that new files show up in the diff and in the change set. */
  stageAll(): void {
    this.git(["add", "-A"]);
  }

  changedFiles(): Array<{ path: string; status: string }> {
    return this.git(["diff", "--cached", "--name-status", "--no-renames"])
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const [status = "", ...rest] = line.split("\t");
        return { status, path: rest.join("\t") };
      });
  }

  /** Added plus deleted lines across the staged change set. */
  diffLineCount(): number {
    return this.git(["diff", "--cached", "--numstat", "--no-renames"])
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .reduce((sum, line) => {
        const [added = "0", deleted = "0"] = line.split("\t");
        return sum + (Number.parseInt(added, 10) || 0) + (Number.parseInt(deleted, 10) || 0);
      }, 0);
  }

  diff(): string {
    const full = this.git(["diff", "--cached", "--no-renames"]);
    if (full.length <= MAX_DIFF_CHARS) return full;
    return `${full.slice(0, MAX_DIFF_CHARS)}\n… [diff truncated at ${MAX_DIFF_CHARS} characters; read the changed files for the rest]`;
  }

  diffStat(): string {
    return this.git(["diff", "--cached", "--stat", "--no-renames"]).trim();
  }

  commit(message: string, author: { name: string; email: string }): string {
    this.git([
      "-c",
      `user.name=${author.name}`,
      "-c",
      `user.email=${author.email}`,
      "commit",
      "-m",
      message,
    ]);
    return this.headCommit();
  }
}

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "change";
}
