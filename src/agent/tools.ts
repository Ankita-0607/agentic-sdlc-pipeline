import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AuditLog } from "../audit/audit.js";
import type { PolicyEngine, ToolName } from "../policy/policy.js";
import type { Role, Stage } from "../types.js";

/**
 * The only ways an agent can touch the repository.
 *
 * There is deliberately no general shell tool. Agents can read, search, write
 * inside the policy's writable paths, and trigger the one test command the
 * policy names. Each tool asks the PolicyEngine before acting and records the
 * decision in the audit log.
 */

export interface ToolContext {
  role: Role;
  stage: Stage;
  policy: PolicyEngine;
  audit: AuditLog;
  /** Repository-relative paths written during this run (shared across agents). */
  changed: Set<string>;
}

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  name: ToolName;
  description: string;
  schema: S;
  run(input: z.infer<S>, ctx: ToolContext): Promise<string> | string;
  /** What to store in the audit log instead of the raw input (e.g. a hash instead of file contents). */
  auditInput?(input: z.infer<S>): Record<string, unknown>;
}

/** An expected, recoverable failure. Returned to the model as an error result so it can adapt. */
export class ToolError extends Error {}

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".agent-runs", ".eval-workspaces"]);
const MAX_READ_BYTES = 120_000;
const MAX_LISTED = 400;
const MAX_MATCHES = 80;

function walk(root: string, policy: PolicyEngine, startRel = ""): string[] {
  const out: string[] = [];
  const stack = [startRel];
  while (stack.length > 0) {
    const dirRel = stack.pop()!;
    const dirAbs = path.join(root, dirRel);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
      } else if (entry.isFile() && !policy.isHidden(rel)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

function denyAndThrow(ctx: ToolContext, tool: string, target: string, rule: string, reason: string): never {
  ctx.audit.record("policy_decision", ctx.stage, ctx.role, {
    tool,
    target,
    allowed: false,
    rule,
    reason,
  });
  throw new ToolError(`Denied by policy (${rule}): ${reason}`);
}

const sha256 = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

export const listFiles: AgentTool = {
  name: "list_files",
  description:
    "List files in the repository (or under one directory). Use this first to learn the layout. Dependency and build folders are omitted.",
  schema: z.object({
    dir: z.string().optional().describe('Repository-relative directory, e.g. "src". Omit for the whole repository.'),
  }),
  run(input: { dir?: string }, ctx) {
    let start = "";
    if (input.dir && input.dir !== ".") {
      const resolved = ctx.policy.resolve(input.dir);
      if (!resolved) throw new ToolError(`"${input.dir}" is outside the workspace`);
      start = resolved.rel;
    }
    const files = walk(ctx.policy.root, ctx.policy, start);
    if (files.length === 0) return "(no files)";
    const shown = files.slice(0, MAX_LISTED);
    const more = files.length > shown.length ? `\n… and ${files.length - shown.length} more` : "";
    return shown.join("\n") + more;
  },
};

export const readFile: AgentTool = {
  name: "read_file",
  description: "Read a text file from the repository. Returns the content with line numbers.",
  schema: z.object({
    path: z.string().describe("Repository-relative path."),
    start_line: z.number().int().positive().optional(),
    end_line: z.number().int().positive().optional(),
  }),
  run(input: { path: string; start_line?: number; end_line?: number }, ctx) {
    const decision = ctx.policy.checkRead(input.path);
    if (!decision.allowed || !decision.abs) {
      denyAndThrow(ctx, "read_file", input.path, decision.rule, decision.reason);
    }
    if (!fs.existsSync(decision.abs) || !fs.statSync(decision.abs).isFile()) {
      throw new ToolError(`No such file: ${input.path}`);
    }
    if (fs.statSync(decision.abs).size > MAX_READ_BYTES) {
      throw new ToolError(`${input.path} is larger than ${MAX_READ_BYTES} bytes; read a line range instead`);
    }
    const lines = fs.readFileSync(decision.abs, "utf8").split("\n");
    const from = Math.max(1, input.start_line ?? 1);
    const to = Math.min(lines.length, input.end_line ?? lines.length);
    return lines
      .slice(from - 1, to)
      .map((line, i) => `${String(from + i).padStart(4)}  ${line}`)
      .join("\n");
  },
};

export const searchCode: AgentTool = {
  name: "search_code",
  description:
    "Search file contents with a JavaScript regular expression. Returns matching lines as path:line: text.",
  schema: z.object({
    pattern: z.string().describe("Regular expression, e.g. \"function turnaround\"."),
    dir: z.string().optional().describe("Restrict the search to this directory."),
  }),
  run(input: { pattern: string; dir?: string }, ctx) {
    let regex: RegExp;
    try {
      regex = new RegExp(input.pattern);
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
    }
    let start = "";
    if (input.dir && input.dir !== ".") {
      const resolved = ctx.policy.resolve(input.dir);
      if (!resolved) throw new ToolError(`"${input.dir}" is outside the workspace`);
      start = resolved.rel;
    }
    const matches: string[] = [];
    for (const rel of walk(ctx.policy.root, ctx.policy, start)) {
      const abs = path.join(ctx.policy.root, rel);
      if (fs.statSync(abs).size > MAX_READ_BYTES) continue;
      const text = fs.readFileSync(abs, "utf8");
      if (text.includes("\0")) continue; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matches.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (matches.length >= MAX_MATCHES) return matches.join("\n") + "\n… (more matches not shown)";
        }
      }
    }
    return matches.length > 0 ? matches.join("\n") : "(no matches)";
  },
};

function applyWrite(ctx: ToolContext, tool: string, requested: string, content: string): string {
  const decision = ctx.policy.checkWrite(requested, content, ctx.changed);
  if (!decision.allowed || !decision.abs || !decision.rel) {
    denyAndThrow(ctx, tool, requested, decision.rule, decision.reason);
  }
  ctx.audit.record("policy_decision", ctx.stage, ctx.role, {
    tool,
    target: decision.rel,
    allowed: true,
    rule: decision.rule,
    reason: decision.reason,
  });
  fs.mkdirSync(path.dirname(decision.abs), { recursive: true });
  fs.writeFileSync(decision.abs, content);
  ctx.changed.add(decision.rel);
  return decision.rel;
}

export const writeFile: AgentTool = {
  name: "write_file",
  description:
    "Create a file or replace its entire content. Only paths the repository policy marks writable are accepted.",
  schema: z.object({
    path: z.string().describe("Repository-relative path."),
    content: z.string().describe("The complete new file content."),
  }),
  run(input: { path: string; content: string }, ctx) {
    const rel = applyWrite(ctx, "write_file", input.path, input.content);
    return `Wrote ${rel} (${Buffer.byteLength(input.content)} bytes)`;
  },
  auditInput: (input: { path: string; content: string }) => ({
    path: input.path,
    bytes: Buffer.byteLength(input.content),
    sha256: sha256(input.content),
  }),
};

export const editFile: AgentTool = {
  name: "edit_file",
  description:
    "Replace one exact snippet in an existing file. `old_text` must occur exactly once; include surrounding lines to make it unique.",
  schema: z.object({
    path: z.string().describe("Repository-relative path."),
    old_text: z.string().min(1),
    new_text: z.string(),
  }),
  run(input: { path: string; old_text: string; new_text: string }, ctx) {
    const readable = ctx.policy.checkRead(input.path);
    if (!readable.allowed || !readable.abs) {
      denyAndThrow(ctx, "edit_file", input.path, readable.rule, readable.reason);
    }
    if (!fs.existsSync(readable.abs)) throw new ToolError(`No such file: ${input.path}`);
    const current = fs.readFileSync(readable.abs, "utf8");
    const occurrences = current.split(input.old_text).length - 1;
    if (occurrences !== 1) {
      throw new ToolError(`old_text occurs ${occurrences} times in ${input.path}; it must occur exactly once`);
    }
    const rel = applyWrite(ctx, "edit_file", input.path, current.replace(input.old_text, () => input.new_text));
    return `Edited ${rel}`;
  },
  auditInput: (input: { path: string; old_text: string; new_text: string }) => ({
    path: input.path,
    removed_bytes: Buffer.byteLength(input.old_text),
    added_bytes: Buffer.byteLength(input.new_text),
    new_text_sha256: sha256(input.new_text),
  }),
};

export interface TestRun {
  passed: boolean;
  exit_code: number | null;
  timed_out: boolean;
  output_tail: string;
}

const OUTPUT_TAIL_CHARS = 6_000;
const ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "APPDATA"];

/**
 * Run the policy's test command. Agent-written tests are untrusted code, so the
 * child process gets a minimal environment: API keys, GitHub tokens and
 * everything else in the parent environment are not passed down.
 */
export function runTestCommand(policy: PolicyEngine): Promise<TestRun> {
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1", FORCE_COLOR: "0" };
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const { test, timeout_seconds } = policy.policy.commands;

  return new Promise((resolve) => {
    // `shell: true` is acceptable here because the command string comes from
    // the reviewed policy file, never from model output.
    // `detached` puts the shell and everything it starts in one process group,
    // so a timeout can stop the whole tree and not just the shell.
    const child = spawn(test, {
      cwd: policy.root,
      env,
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeout_seconds * 1000);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      resolve({
        passed: code === 0 && !timedOut,
        exit_code: code,
        timed_out: timedOut,
        output_tail: output.slice(-OUTPUT_TAIL_CHARS),
      });
    };
    child.on("error", (err) => {
      output += `\n[failed to start test command: ${err.message}]`;
      finish(null);
    });
    child.on("close", finish);
  });
}

export const runTests: AgentTool = {
  name: "run_tests",
  description:
    "Run the repository's test suite (the command is fixed by repository policy; it takes no arguments). Returns the exit status and the end of the output.",
  schema: z.object({}),
  async run(_input, ctx) {
    const result = await runTestCommand(ctx.policy);
    const status = result.timed_out
      ? "TIMED OUT"
      : result.passed
        ? "PASSED"
        : `FAILED (exit code ${result.exit_code})`;
    return `Tests ${status}\n\n${result.output_tail}`;
  },
};

export const ALL_TOOLS: Record<ToolName, AgentTool> = {
  list_files: listFiles,
  read_file: readFile,
  search_code: searchCode,
  write_file: writeFile,
  edit_file: editFile,
  run_tests: runTests,
};

/** The tools a role may use, according to the policy's `roles` section. */
export function toolsForRole(role: Role, policy: PolicyEngine): AgentTool[] {
  return (policy.policy.roles[role] ?? []).map((name) => ALL_TOOLS[name]);
}
