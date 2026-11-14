import { z } from "zod";

/**
 * The artifacts that flow between pipeline stages. Each one is produced by an
 * agent through a `submit_*` tool call and validated against these schemas
 * before the pipeline accepts it, so a stage can never hand free-form text to
 * the next one.
 */

export const SpecSchema = z.object({
  title: z.string().min(1),
  problem: z.string().min(1).describe("What is wrong or missing today, in two or three sentences."),
  acceptance_criteria: z
    .array(
      z.object({
        id: z.string().describe('Short stable id such as "AC1".'),
        text: z.string().describe("One observable, testable behaviour."),
      }),
    )
    .min(1),
  out_of_scope: z.array(z.string()),
  open_questions: z
    .array(z.string())
    .describe("Ambiguities a human should resolve. Empty when the issue is clear."),
  risk: z.enum(["low", "medium", "high"]),
  risk_rationale: z.string(),
});
export type Spec = z.infer<typeof SpecSchema>;

export const PlanSchema = z.object({
  summary: z.string().min(1),
  steps: z
    .array(
      z.object({
        id: z.string(),
        description: z.string(),
        files: z.array(z.string()).describe("Repository-relative paths this step creates or edits."),
        covers: z.array(z.string()).describe("Acceptance criterion ids this step satisfies."),
      }),
    )
    .min(1),
  test_strategy: z.string(),
});
export type Plan = z.infer<typeof PlanSchema>;

export const ImplementationSchema = z.object({
  summary: z.string().min(1),
  criteria_status: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["met", "not_met"]),
      evidence: z.string().describe("The test or code location that demonstrates it."),
    }),
  ),
  tests_passing: z.boolean().describe("Result of the last run_tests call."),
  notes: z.string().describe("Anything the human reviewer should know. Empty if nothing."),
});
export type Implementation = z.infer<typeof ImplementationSchema>;

export const ReviewSchema = z.object({
  decision: z.enum(["approve", "request_changes"]),
  summary: z.string().min(1),
  findings: z.array(
    z.object({
      severity: z.enum(["blocking", "major", "minor", "nit"]),
      file: z.string(),
      comment: z.string(),
    }),
  ),
  criteria_check: z.array(z.object({ id: z.string(), met: z.boolean(), note: z.string() })),
});
export type Review = z.infer<typeof ReviewSchema>;

export interface Issue {
  /** Where the issue came from, e.g. "examples/issues/001.md" or "owner/repo#12". */
  source: string;
  number?: number;
  title: string;
  body: string;
}

export const ROLES = ["spec", "planner", "implementer", "reviewer"] as const;
export type Role = (typeof ROLES)[number];

export type Stage = "intake" | "spec" | "plan" | "approval" | "implement" | "verify" | "review" | "publish";

export interface Approval {
  approved: boolean;
  /** "human": a named person decided. "auto": the policy waived the gate. */
  kind: "human" | "auto";
  approver: string;
  note: string;
  at: string;
}

/** Persisted between the plan phase and the build phase (they can be separate processes). */
export const PlanStateSchema = z.object({
  run_id: z.string(),
  issue: z.object({
    source: z.string(),
    number: z.number().optional(),
    title: z.string(),
    body: z.string(),
  }),
  spec: SpecSchema,
  plan: PlanSchema,
  plan_policy_warnings: z.array(z.string()),
  base_commit: z.string(),
});
export type PlanState = z.infer<typeof PlanStateSchema>;

export type RunStatus =
  | "awaiting_plan_approval"
  | "ready_for_human_review"
  | "rejected_at_gate"
  | "failed_verification"
  | "review_not_converged"
  | "budget_exceeded"
  | "error";

export interface RoundRecord {
  round: number;
  implementation?: Implementation;
  verification?: VerificationResult;
  review?: Review;
}

export interface VerificationResult {
  passed: boolean;
  tests: { passed: boolean; exit_code: number | null; output_tail: string };
  policy_violations: string[];
  changed_files: string[];
  diff_lines: number;
}

export interface RunResult {
  run_id: string;
  status: RunStatus;
  branch?: string;
  commit?: string;
  rounds: RoundRecord[];
  report_path: string;
  detail: string;
}
