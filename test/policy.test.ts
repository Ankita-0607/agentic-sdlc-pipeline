import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy, parsePolicy, PolicyEngine } from "../src/policy/policy.js";
import { policyWith, POLICY_YAML, tempDir } from "./helpers.js";

function engine(root = tempDir()) {
  return new PolicyEngine(policyWith(), root);
}

describe("policy file", () => {
  it("rejects a policy with missing sections and says which", () => {
    expect(() => parsePolicy("version: 1\nworkspace:\n  writable: []\n")).toThrow(/Invalid agent policy/);
  });

  it("refuses to run when the repository has no policy at all", () => {
    expect(() => loadPolicy(tempDir())).toThrow(/refuses to run without an explicit policy/);
  });

  it("rejects an unknown tool name in a role grant", () => {
    expect(() => parsePolicy(POLICY_YAML.replace("run_tests]", "run_shell]"))).toThrow(/Invalid agent policy/);
  });
});

describe("workspace boundary", () => {
  it.each(["../outside.txt", "/etc/passwd", "src/../../escape.ts", "", "src/\0bad"])(
    "rejects a path outside the workspace: %j",
    (requested) => {
      const e = engine();
      expect(e.resolve(requested)).toBeNull();
      expect(e.checkWrite(requested, "x", new Set()).allowed).toBe(false);
      expect(e.checkRead(requested).allowed).toBe(false);
    },
  );

  it("rejects a symlink that points out of the workspace", () => {
    const root = tempDir();
    const outside = tempDir();
    fs.mkdirSync(path.join(root, "src"));
    fs.symlinkSync(outside, path.join(root, "src", "link"));
    const decision = new PolicyEngine(policyWith(), root).checkWrite("src/link/evil.ts", "x", new Set());
    expect(decision).toMatchObject({ allowed: false, rule: "workspace.boundary" });
  });
});

describe("write rules", () => {
  it("allows a write inside a writable path", () => {
    expect(engine().checkWrite("src/new.ts", "export {}", new Set())).toMatchObject({
      allowed: true,
      rel: "src/new.ts",
    });
  });

  it("denies a path that matches no writable glob", () => {
    expect(engine().checkWrite("docs/readme.md", "x", new Set())).toMatchObject({
      allowed: false,
      rule: "workspace.writable",
    });
  });

  it("lets protected win over writable", () => {
    expect(engine().checkWrite("src/generated/client.ts", "x", new Set())).toMatchObject({
      allowed: false,
      rule: "workspace.protected",
    });
  });

  it("never lets an agent edit the policy file or .git, whatever the YAML says", () => {
    const wideOpen = new PolicyEngine(
      policyWith((p) => {
        p.workspace.writable = ["**"];
        p.workspace.protected = [];
      }),
      tempDir(),
    );
    expect(wideOpen.checkWrite("agent-policy.yaml", "x", new Set()).allowed).toBe(false);
    expect(wideOpen.checkWrite(".git/hooks/pre-commit", "x", new Set()).allowed).toBe(false);
    expect(wideOpen.checkWrite("anything/else.txt", "x", new Set()).allowed).toBe(true);
  });

  it("enforces the file size limit", () => {
    expect(engine().checkWrite("src/big.ts", "x".repeat(2001), new Set())).toMatchObject({
      allowed: false,
      rule: "limits.max_file_bytes",
    });
  });

  it("enforces the changed-file limit but still allows rewriting a file already changed", () => {
    const changed = new Set(["src/a.ts", "src/b.ts", "src/c.ts"]);
    const e = engine();
    expect(e.checkWrite("src/d.ts", "x", changed)).toMatchObject({ allowed: false, rule: "limits.max_files_changed" });
    expect(e.checkWrite("src/a.ts", "x", changed).allowed).toBe(true);
  });

  it.each([
    ["private key", "-----BEGIN RSA PRIVATE KEY-----\nabc"],
    ["AWS key", 'const k = "AKIAIOSFODNN7EXAMPLE";'],
    ["GitHub token", `token: ghp_${"a".repeat(36)}`],
    ["Anthropic key", `sk-ant-${"b".repeat(24)}`],
  ])("blocks a write containing a %s", (_name, content) => {
    expect(engine().checkWrite("src/config.ts", content, new Set())).toMatchObject({ allowed: false, rule: "secrets" });
  });

  it("supports extra secret patterns from the policy", () => {
    const e = new PolicyEngine(
      policyWith((p) => {
        p.secrets.extra_patterns = ["INTERNAL-[0-9]{6}"];
      }),
      tempDir(),
    );
    expect(e.checkWrite("src/a.ts", "id = INTERNAL-123456", new Set()).allowed).toBe(false);
  });
});

describe("read rules", () => {
  it("denies unreadable paths so their content never reaches the model", () => {
    const e = engine();
    expect(e.checkRead(".env.production")).toMatchObject({ allowed: false, rule: "workspace.unreadable" });
    expect(e.checkRead("secrets/db.txt").allowed).toBe(false);
    expect(e.checkRead(".git/config").allowed).toBe(false);
    expect(e.checkRead("src/app.ts").allowed).toBe(true);
  });
});

describe("role grants", () => {
  it("grants tools per role", () => {
    const e = engine();
    expect(e.checkTool("implementer", "write_file").allowed).toBe(true);
    expect(e.checkTool("reviewer", "write_file")).toMatchObject({ allowed: false, rule: "roles" });
    expect(e.checkTool("planner", "run_tests").allowed).toBe(false);
    expect(e.checkTool("implementer", "bash").allowed).toBe(false);
  });
});

describe("change-set re-check", () => {
  it("passes a change set that stays within policy", () => {
    expect(engine().checkChangeSet([{ path: "src/a.ts", status: "M" }], 10)).toEqual([]);
  });

  it("reports files outside writable paths, protected files and size limits", () => {
    const violations = engine().checkChangeSet(
      [
        { path: "src/a.ts", status: "M" },
        { path: "package.json", status: "M" },
        { path: "build/out.js", status: "A" },
        { path: "test/b.ts", status: "A" },
      ],
      500,
    );
    expect(violations).toHaveLength(4);
    expect(violations.join("\n")).toMatch(/max_files_changed/);
    expect(violations.join("\n")).toMatch(/max_diff_lines/);
    expect(violations.join("\n")).toMatch(/workspace.protected: package.json/);
    expect(violations.join("\n")).toMatch(/workspace.writable: build\/out.js/);
  });
});

describe("plan pre-check", () => {
  it("warns the approver about files the implementer will not be able to change", () => {
    const warnings = engine().checkPlannedFiles(["src/a.ts", "package.json", "../x", "README.md"]);
    expect(warnings).toEqual([
      "package.json: protected path",
      "../x: outside the workspace",
      "README.md: not a writable path",
      "plan touches 4 files; the limit is 3",
    ]);
  });
});

describe("the policy this repository ships", () => {
  const e = new PolicyEngine(loadPolicy(path.resolve(import.meta.dirname, "..")), path.resolve(import.meta.dirname, ".."));

  it("confines agents to the sample service", () => {
    expect(e.checkWrite("examples/sample-service/src/sla.ts", "x", new Set()).allowed).toBe(true);
    expect(e.checkWrite("src/cli.ts", "x", new Set()).allowed).toBe(false);
    expect(e.checkWrite(".github/workflows/ci.yml", "x", new Set()).allowed).toBe(false);
    expect(e.checkWrite("examples/sample-service/agent-policy.yaml", "x", new Set()).allowed).toBe(false);
    expect(e.checkWrite("examples/sample-service/package.json", "x", new Set()).allowed).toBe(false);
  });
});
