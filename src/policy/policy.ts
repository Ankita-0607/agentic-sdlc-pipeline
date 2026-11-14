import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import YAML from "yaml";
import { z } from "zod";
import { ROLES, type Role } from "../types.js";

/**
 * Policy-as-code for the pipeline.
 *
 * The policy file lives in the target repository and is reviewed like any
 * other code. Every rule here is enforced in the tool layer, outside the
 * model: an agent can be asked, tricked or prompt-injected into *trying*
 * something, but the attempt is evaluated by this module, not by the prompt.
 */

export const TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_code",
  "write_file",
  "edit_file",
  "run_tests",
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const PolicySchema = z.object({
  version: z.literal(1),
  workspace: z.object({
    /** Globs agents may create or modify. Anything not matched is read-only. */
    writable: z.array(z.string()).min(1),
    /** Globs that are never writable, even if they also match `writable`. Deny wins. */
    protected: z.array(z.string()).default([]),
    /** Globs agents may not read, so their contents are never sent to the model. */
    unreadable: z.array(z.string()).default([]),
  }),
  limits: z.object({
    max_files_changed: z.number().int().positive(),
    max_file_bytes: z.number().int().positive(),
    max_diff_lines: z.number().int().positive(),
    /** Rework rounds allowed after the first implementation attempt. */
    max_rework_rounds: z.number().int().min(0),
    max_turns_per_agent: z.number().int().positive(),
  }),
  budget: z.object({
    max_cost_usd: z.number().positive(),
    max_total_tokens: z.number().int().positive(),
  }),
  commands: z.object({
    /** The only command an agent can cause to run. Agents cannot pass arguments to it. */
    test: z.string().min(1),
    timeout_seconds: z.number().int().positive().default(300),
  }),
  gates: z.object({
    /** `required`: a named human must approve the plan before any code is written. */
    plan_approval: z.enum(["required", "auto"]),
  }),
  /** Least privilege: the tools each agent role is allowed to call. */
  roles: z.record(z.enum(ROLES), z.array(z.enum(TOOL_NAMES))),
  secrets: z
    .object({
      /** Extra regular expressions, on top of the built-in ones, that block a write. */
      extra_patterns: z.array(z.string()).default([]),
    })
    .default({ extra_patterns: [] }),
  /** Optional model override per role. Defaults come from src/config.ts. */
  models: z.record(z.enum(ROLES), z.string()).optional(),
});
export type Policy = z.infer<typeof PolicySchema>;

export interface Decision {
  allowed: boolean;
  /** The policy rule that decided, e.g. "workspace.protected". */
  rule: string;
  reason: string;
}

const allow = (rule: string, reason: string): Decision => ({ allowed: true, rule, reason });
const deny = (rule: string, reason: string): Decision => ({ allowed: false, rule, reason });

const BUILTIN_SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "private key block", regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "AWS access key id", regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "GitHub token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

export const POLICY_FILENAME = "agent-policy.yaml";

export function loadPolicy(root: string, file = POLICY_FILENAME): Policy {
  const full = path.resolve(root, file);
  if (!fs.existsSync(full)) {
    throw new Error(
      `No ${file} found in ${root}. The pipeline refuses to run without an explicit policy.`,
    );
  }
  return parsePolicy(fs.readFileSync(full, "utf8"));
}

export function parsePolicy(yamlText: string): Policy {
  const result = PolicySchema.safeParse(YAML.parse(yamlText));
  if (!result.success) {
    throw new Error(`Invalid agent policy:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export class PolicyEngine {
  readonly root: string;
  private readonly isWritable: picomatch.Matcher;
  private readonly isProtected: picomatch.Matcher;
  private readonly isUnreadable: picomatch.Matcher;
  private readonly secretPatterns: Array<{ name: string; regex: RegExp }>;

  constructor(
    readonly policy: Policy,
    root: string,
  ) {
    this.root = fs.realpathSync(path.resolve(root));
    const opts = { dot: true };
    this.isWritable = picomatch(policy.workspace.writable, opts);
    // The policy file can never be edited by an agent, whatever the YAML says.
    this.isProtected = picomatch([...policy.workspace.protected, POLICY_FILENAME, ".git/**"], opts);
    this.isUnreadable = picomatch([...policy.workspace.unreadable, ".git/**"], opts);
    this.secretPatterns = [
      ...BUILTIN_SECRET_PATTERNS,
      ...policy.secrets.extra_patterns.map((p, i) => ({
        name: `secrets.extra_patterns[${i}]`,
        regex: new RegExp(p),
      })),
    ];
  }

  /**
   * Turn a model-supplied path into a repository-relative POSIX path, or
   * return null if it points outside the workspace. Model output is untrusted
   * input: `../../etc/passwd`, absolute paths and symlinks that leave the
   * workspace are all rejected here.
   */
  resolve(requested: string): { rel: string; abs: string } | null {
    if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) return null;
    const abs = path.resolve(this.root, requested);
    const rel = path.relative(this.root, abs);
    if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;

    // Follow symlinks on the deepest part of the path that already exists.
    let existing = abs;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    const real = fs.realpathSync(existing);
    const realRel = path.relative(this.root, real);
    if (realRel === ".." || realRel.startsWith(".." + path.sep) || path.isAbsolute(realRel)) return null;

    return { rel: rel.split(path.sep).join("/"), abs };
  }

  checkTool(role: Role, tool: string): Decision {
    const granted = this.policy.roles[role] ?? [];
    return (granted as string[]).includes(tool)
      ? allow("roles", `${role} is granted ${tool}`)
      : deny("roles", `the ${role} role is not granted the ${tool} tool`);
  }

  checkRead(requested: string): Decision & { rel?: string; abs?: string } {
    const resolved = this.resolve(requested);
    if (!resolved) return deny("workspace.boundary", `"${requested}" is outside the workspace`);
    if (this.isUnreadable(resolved.rel)) {
      return deny("workspace.unreadable", `${resolved.rel} is marked unreadable for agents`);
    }
    return { ...allow("workspace.readable", `${resolved.rel} is readable`), ...resolved };
  }

  /** True when a path should be hidden from directory listings and search. */
  isHidden(rel: string): boolean {
    return this.isUnreadable(rel);
  }

  checkWrite(
    requested: string,
    content: string,
    alreadyChanged: ReadonlySet<string>,
  ): Decision & { rel?: string; abs?: string } {
    const resolved = this.resolve(requested);
    if (!resolved) return deny("workspace.boundary", `"${requested}" is outside the workspace`);
    const { rel } = resolved;

    if (this.isProtected(rel)) return deny("workspace.protected", `${rel} is a protected path`);
    if (!this.isWritable(rel)) {
      return deny("workspace.writable", `${rel} does not match any writable path in the policy`);
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.policy.limits.max_file_bytes) {
      return deny(
        "limits.max_file_bytes",
        `${rel} would be ${bytes} bytes; the limit is ${this.policy.limits.max_file_bytes}`,
      );
    }
    if (!alreadyChanged.has(rel) && alreadyChanged.size >= this.policy.limits.max_files_changed) {
      return deny(
        "limits.max_files_changed",
        `this run already changed ${alreadyChanged.size} files; the limit is ${this.policy.limits.max_files_changed}`,
      );
    }
    const secret = this.findSecret(content);
    if (secret) return deny("secrets", `content looks like it contains a ${secret}`);

    return { ...allow("workspace.writable", `${rel} is writable`), ...resolved };
  }

  findSecret(content: string): string | null {
    for (const { name, regex } of this.secretPatterns) {
      if (regex.test(content)) return name;
    }
    return null;
  }

  /**
   * Defence in depth: after the agents finish, the orchestrator re-checks what
   * actually changed on disk (from git, not from the agents' own account).
   * This catches anything that bypassed the write tools, for example files
   * created as a side effect of the test command.
   */
  checkChangeSet(changed: Array<{ path: string; status: string }>, diffLines: number): string[] {
    const violations: string[] = [];
    if (changed.length > this.policy.limits.max_files_changed) {
      violations.push(
        `limits.max_files_changed: ${changed.length} files changed, limit is ${this.policy.limits.max_files_changed}`,
      );
    }
    if (diffLines > this.policy.limits.max_diff_lines) {
      violations.push(
        `limits.max_diff_lines: diff is ${diffLines} lines, limit is ${this.policy.limits.max_diff_lines}`,
      );
    }
    for (const file of changed) {
      if (this.isProtected(file.path)) {
        violations.push(`workspace.protected: ${file.path} was changed`);
      } else if (!this.isWritable(file.path)) {
        violations.push(`workspace.writable: ${file.path} was changed but is not a writable path`);
      }
    }
    return violations;
  }

  /** Advisory check on a plan, shown to the human approver before any code is written. */
  checkPlannedFiles(files: string[]): string[] {
    const warnings: string[] = [];
    const unique = [...new Set(files)];
    for (const file of unique) {
      const resolved = this.resolve(file);
      if (!resolved) warnings.push(`${file}: outside the workspace`);
      else if (this.isProtected(resolved.rel)) warnings.push(`${resolved.rel}: protected path`);
      else if (!this.isWritable(resolved.rel)) warnings.push(`${resolved.rel}: not a writable path`);
    }
    if (unique.length > this.policy.limits.max_files_changed) {
      warnings.push(
        `plan touches ${unique.length} files; the limit is ${this.policy.limits.max_files_changed}`,
      );
    }
    return warnings;
  }
}
