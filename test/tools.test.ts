import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  editFile,
  listFiles,
  readFile,
  runTestCommand,
  runTests,
  searchCode,
  ToolError,
  toolsForRole,
  writeFile,
  type ToolContext,
} from "../src/agent/tools.js";
import { readAuditLog } from "../src/audit/audit.js";
import { PolicyEngine } from "../src/policy/policy.js";
import { makeRepo, makeRuntime, policyWith, ScriptedLlm } from "./helpers.js";

function context(root = makeRepo(), policy = policyWith()) {
  const rt = makeRuntime(root, new ScriptedLlm({}), policy);
  const ctx: ToolContext = { role: "implementer", stage: "implement", policy: rt.policy, audit: rt.audit, changed: rt.changed };
  return { root, ctx, auditFile: rt.auditFile };
}

describe("read tools", () => {
  it("lists files but hides unreadable ones and skips .git", async () => {
    const { root, ctx } = context();
    fs.writeFileSync(path.join(root, ".env.local"), "TOKEN=1");
    const listing = await listFiles.run({}, ctx);
    expect(listing).toContain("src/greet.cjs");
    expect(listing).not.toContain(".env.local");
    expect(listing).not.toContain(".git/");
  });

  it("reads a file with line numbers and supports ranges", async () => {
    const { ctx } = context();
    expect(await readFile.run({ path: "test/run.cjs", start_line: 1, end_line: 1 }, ctx)).toBe(
      '   1  const assert = require("node:assert");',
    );
  });

  it("refuses unreadable files and records the denial", async () => {
    const { root, ctx, auditFile } = context();
    fs.writeFileSync(path.join(root, ".env"), "API_KEY=super-secret");
    expect(() => readFile.run({ path: ".env" }, ctx)).toThrow(ToolError);
    expect(readAuditLog(auditFile)[0]).toMatchObject({
      type: "policy_decision",
      data: { allowed: false, rule: "workspace.unreadable" },
    });
  });

  it("searches readable files only", async () => {
    const { root, ctx } = context();
    fs.writeFileSync(path.join(root, ".env"), "greet=1");
    const hits = await searchCode.run({ pattern: "greet" }, ctx);
    expect(hits).toContain("src/greet.cjs:1:");
    expect(hits).not.toContain(".env");
    expect(() => searchCode.run({ pattern: "(" }, ctx)).toThrow(/Invalid regular expression/);
  });
});

describe("write tools", () => {
  it("writes inside writable paths and tracks the change", async () => {
    const { root, ctx, auditFile } = context();
    await writeFile.run({ path: "src/new.cjs", content: "exports.x = 1;\n" }, ctx);
    expect(fs.readFileSync(path.join(root, "src/new.cjs"), "utf8")).toBe("exports.x = 1;\n");
    expect([...ctx.changed]).toEqual(["src/new.cjs"]);
    expect(readAuditLog(auditFile)[0]).toMatchObject({ type: "policy_decision", data: { allowed: true } });
  });

  it.each([
    ["a protected file", "package.json"],
    ["a path that is not writable", "README.md"],
    ["the policy file", "agent-policy.yaml"],
    ["a path outside the workspace", "../../tmp/evil.sh"],
  ])("refuses to write %s and leaves the disk untouched", async (_label, target) => {
    const { root, ctx } = context();
    const before = fs.existsSync(path.join(root, target)) ? fs.readFileSync(path.join(root, target), "utf8") : null;
    expect(() => writeFile.run({ path: target, content: "pwned" }, ctx)).toThrow(/Denied by policy/);
    const after = fs.existsSync(path.join(root, target)) ? fs.readFileSync(path.join(root, target), "utf8") : null;
    expect(after).toBe(before);
    expect(ctx.changed.size).toBe(0);
  });

  it("refuses to write content that contains a credential", async () => {
    const { ctx } = context();
    expect(() => writeFile.run({ path: "src/config.cjs", content: `key = "sk-ant-${"x".repeat(30)}"` }, ctx)).toThrow(
      /secrets/,
    );
  });

  it("edits one exact occurrence and rejects ambiguous edits", async () => {
    const { root, ctx } = context();
    await editFile.run({ path: "src/greet.cjs", old_text: "Hello", new_text: "Hi" }, ctx);
    expect(fs.readFileSync(path.join(root, "src/greet.cjs"), "utf8")).toContain('"Hi, "');
    expect(() => editFile.run({ path: "src/greet.cjs", old_text: "e", new_text: "E" }, ctx)).toThrow(/exactly once/);
    expect(() => editFile.run({ path: "src/greet.cjs", old_text: "absent", new_text: "x" }, ctx)).toThrow(/0 times/);
  });

  it("stores a hash of written content in the audit input, not the content", () => {
    const summary = writeFile.auditInput!({ path: "src/a.cjs", content: "secret business logic" });
    expect(summary).toMatchObject({ path: "src/a.cjs", bytes: 21 });
    expect(JSON.stringify(summary)).not.toContain("secret business logic");
  });
});

describe("test command", () => {
  it("runs the policy's command and reports the result", async () => {
    const { ctx } = context();
    expect(await runTests.run({}, ctx)).toMatch(/^Tests PASSED/);
  });

  it("reports failure with the output tail", async () => {
    const { root, ctx } = context();
    fs.writeFileSync(path.join(root, "src/greet.cjs"), 'exports.greet = () => "wrong";\n');
    const output = await runTests.run({}, ctx);
    expect(output).toMatch(/^Tests FAILED \(exit code 1\)/);
    expect(output).toContain("AssertionError");
  });

  it("does not pass API keys or tokens to the test process", async () => {
    const root = makeRepo();
    const policy = policyWith((p) => {
      p.commands.test = `node -e "process.exit(process.env.ANTHROPIC_API_KEY || process.env.GITHUB_TOKEN ? 1 : 0)"`;
    });
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    process.env.GITHUB_TOKEN = "ghs_test";
    try {
      expect((await runTestCommand(new PolicyEngine(policy, root))).passed).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("kills a test command that exceeds the timeout", async () => {
    const policy = policyWith((p) => {
      p.commands.test = `node -e "setTimeout(() => {}, 60000)"`;
      p.commands.timeout_seconds = 1;
    });
    const result = await runTestCommand(new PolicyEngine(policy, makeRepo()));
    expect(result).toMatchObject({ passed: false, timed_out: true });
  });
});

describe("role tool sets", () => {
  it("gives only the implementer write tools", () => {
    const policy = new PolicyEngine(policyWith(), makeRepo());
    const names = (role: Parameters<typeof toolsForRole>[0]) => toolsForRole(role, policy).map((t) => t.name);
    expect(names("implementer")).toContain("write_file");
    expect(names("reviewer")).toEqual(["list_files", "read_file", "search_code", "run_tests"]);
    expect(names("planner")).not.toContain("run_tests");
  });
});
