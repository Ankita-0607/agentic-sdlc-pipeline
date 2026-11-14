import type Anthropic from "@anthropic-ai/sdk";
import type { LlmClient, LlmRequest, LlmResponse } from "./client.js";

/**
 * A deterministic stand-in for the model, used by the test suite, the offline
 * demo and the offline eval mode. It replays a fixed script of tool calls so
 * the pipeline's control flow (gates, policy checks, verification, rework
 * loops, audit) can be exercised without an API key and without cost.
 *
 * It says nothing about model quality: only the live evals do that.
 */

export interface ScriptedCall {
  name: string;
  input: unknown;
}

/** One model turn: the tool calls it makes. An empty turn is the model stopping without a tool call. */
export type ScriptedTurn = ScriptedCall[] | { stop_reason: "refusal" | "max_tokens" };

export const call = (name: string, input: unknown = {}): ScriptedCall => ({ name, input });

export const SCRIPTED_MODEL = "scripted-llm";

export class ScriptedLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private readonly queues: Map<string, ScriptedTurn[]>;
  private counter = 0;

  /**
   * @param script Turns per agent, keyed by that agent's submit tool
   *   ("submit_spec", "submit_plan", "submit_implementation", "submit_review").
   *   A role invoked again (a rework round) continues where its queue left off.
   */
  constructor(script: Record<string, ScriptedTurn[]>) {
    this.queues = new Map(Object.entries(script).map(([key, turns]) => [key, [...turns]]));
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Snapshot the conversation: the agent loop keeps appending to the same array.
    this.requests.push({ ...request, messages: [...request.messages] });
    const key = request.tools.map((t) => t.name).find((name) => this.queues.has(name));
    const turn = key ? this.queues.get(key)!.shift() : undefined;
    if (!turn) {
      const names = request.tools.map((t) => t.name).join(", ");
      throw new Error(`ScriptedLlm: no scripted turn left for an agent with tools [${names}]`);
    }

    const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    if (!Array.isArray(turn)) {
      return { content: [], stop_reason: turn.stop_reason, model: SCRIPTED_MODEL, usage };
    }
    const content = turn.map((c) => ({
      type: "tool_use" as const,
      id: `toolu_scripted_${++this.counter}`,
      name: c.name,
      input: c.input,
    })) as unknown as Anthropic.Beta.BetaContentBlock[];
    return {
      content,
      stop_reason: turn.length > 0 ? "tool_use" : "end_turn",
      model: SCRIPTED_MODEL,
      usage,
    };
  }
}
