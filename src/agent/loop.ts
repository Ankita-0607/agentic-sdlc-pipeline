import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AuditLog } from "../audit/audit.js";
import { ROLE_EFFORT } from "../config.js";
import type { LlmClient } from "../llm/client.js";
import type { UsageTracker } from "../llm/usage.js";
import type { PolicyEngine } from "../policy/policy.js";
import type { Role, Stage } from "../types.js";
import { ToolError, type AgentTool, type ToolContext } from "./tools.js";

/**
 * One agent = one role-specific system prompt + the tools its role is granted
 * + a `submit` tool whose schema is the stage's output contract.
 *
 * The loop is written by hand (rather than using an SDK helper) because the
 * governance hooks live between turns: the budget check before every model
 * call, the policy check and audit record around every tool call.
 */

export interface AgentSpec<T> {
  role: Role;
  stage: Stage;
  system: string;
  task: string;
  tools: AgentTool[];
  submit: { name: string; description: string; schema: z.ZodType<T> };
}

export interface AgentRuntime {
  llm: LlmClient;
  policy: PolicyEngine;
  audit: AuditLog;
  usage: UsageTracker;
  changed: Set<string>;
  model: string;
}

export type AgentFailure = "refusal" | "truncated" | "no_submit" | "max_turns";

export class AgentError extends Error {
  constructor(
    readonly role: Role,
    readonly kind: AgentFailure,
    message: string,
  ) {
    super(`${role} agent: ${message}`);
    this.name = "AgentError";
  }
}

function toApiTool(name: string, description: string, schema: z.ZodType): Anthropic.Beta.BetaTool {
  const { $schema: _ignored, ...jsonSchema } = z.toJSONSchema(schema) as Record<string, unknown>;
  return {
    name,
    description,
    input_schema: jsonSchema as Anthropic.Beta.BetaTool.InputSchema,
    // Large inputs (file contents) stream as they are generated. The API then
    // skips its own validation, so every input is validated with Zod below.
    eager_input_streaming: true,
  };
}

export async function runAgent<T>(spec: AgentSpec<T>, rt: AgentRuntime): Promise<{ result: T; turns: number }> {
  const maxTurns = rt.policy.policy.limits.max_turns_per_agent;
  const toolsByName = new Map(spec.tools.map((t) => [t.name as string, t]));
  const apiTools = [
    ...spec.tools.map((t) => toApiTool(t.name, t.description, t.schema)),
    toApiTool(spec.submit.name, spec.submit.description, spec.submit.schema),
  ];
  const ctx: ToolContext = {
    role: spec.role,
    stage: spec.stage,
    policy: rt.policy,
    audit: rt.audit,
    changed: rt.changed,
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: spec.task }];
  let nudged = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    rt.usage.assertWithinBudget(rt.policy.policy.budget);

    const response = await rt.llm.complete({
      model: rt.model,
      effort: ROLE_EFFORT[spec.role],
      system: spec.system,
      messages,
      tools: apiTools,
    });
    rt.usage.add(spec.role, response.model, response.usage);
    rt.audit.record("llm_call", spec.stage, spec.role, {
      turn,
      model: response.model,
      stop_reason: response.stop_reason,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
    });

    if (response.stop_reason === "refusal") {
      throw new AgentError(spec.role, "refusal", "the model declined this request");
    }
    if (response.stop_reason === "max_tokens") {
      // A tool input cut off at the token limit can still parse as JSON, so
      // never execute this turn's tool calls.
      throw new AgentError(spec.role, "truncated", "response hit the output token limit");
    }

    // Echo the full content back, thinking blocks included, unchanged.
    messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
    if (response.stop_reason === "pause_turn") continue;

    const toolUses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      if (nudged) {
        throw new AgentError(spec.role, "no_submit", `ended twice without calling ${spec.submit.name}`);
      }
      nudged = true;
      messages.push({
        role: "user",
        content: `Your work is only recorded when you call the ${spec.submit.name} tool. Please finish by calling it.`,
      });
      continue;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    let submitted: { value: T } | undefined;

    for (const use of toolUses) {
      const reply = (content: string, isError = false) =>
        results.push({ type: "tool_result", tool_use_id: use.id, content, is_error: isError });

      if (use.name === spec.submit.name) {
        const parsed = spec.submit.schema.safeParse(use.input);
        if (parsed.success) {
          submitted = { value: parsed.data };
          rt.audit.record("agent_submit", spec.stage, spec.role, { tool: use.name, turn });
          reply("Accepted.");
        } else {
          reply(`Rejected, the input does not match the schema:\n${z.prettifyError(parsed.error)}`, true);
        }
        continue;
      }

      const tool = toolsByName.get(use.name);
      const grant = rt.policy.checkTool(spec.role, use.name);
      if (!tool || !grant.allowed) {
        rt.audit.record("policy_decision", spec.stage, spec.role, {
          tool: use.name,
          allowed: false,
          rule: grant.rule,
          reason: grant.reason,
        });
        reply(`Denied by policy (${grant.rule}): ${grant.reason}`, true);
        continue;
      }

      const parsed = tool.schema.safeParse(use.input);
      if (!parsed.success) {
        reply(`Invalid input for ${use.name}:\n${z.prettifyError(parsed.error)}`, true);
        continue;
      }

      const auditInput = tool.auditInput ? tool.auditInput(parsed.data) : (parsed.data as Record<string, unknown>);
      try {
        const output = await tool.run(parsed.data, ctx);
        rt.audit.record("tool_call", spec.stage, spec.role, { tool: use.name, input: auditInput, ok: true });
        reply(output);
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
        rt.audit.record("tool_call", spec.stage, spec.role, {
          tool: use.name,
          input: auditInput,
          ok: false,
          error: err.message,
        });
        reply(err.message, true);
      }
    }

    // All results for one assistant turn go back in a single user message.
    messages.push({ role: "user", content: results });
    if (submitted) return { result: submitted.value, turns: turn };
  }

  throw new AgentError(spec.role, "max_turns", `no result after ${maxTurns} turns (limits.max_turns_per_agent)`);
}
