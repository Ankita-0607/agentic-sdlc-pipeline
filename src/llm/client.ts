import Anthropic from "@anthropic-ai/sdk";
import { MAX_OUTPUT_TOKENS, type Effort } from "../config.js";

/**
 * The narrow slice of the Claude API the pipeline depends on.
 *
 * Everything above this interface (agents, policy, pipeline) is written
 * against it rather than against the SDK, which is what makes the control
 * flow testable offline: tests and the offline demo plug in a scripted
 * implementation, production plugs in `AnthropicLlm`.
 */
export interface LlmRequest {
  model: string;
  effort: Effort;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
}

export type LlmUsage = Pick<
  Anthropic.Beta.BetaUsage,
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens"
>;

export type LlmResponse = Pick<Anthropic.Beta.BetaMessage, "content" | "stop_reason" | "model"> & {
  usage: LlmUsage;
};

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(client?: Anthropic) {
    // Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.
    this.client = client ?? new Anthropic();
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    // Streaming keeps long responses (a full-file write can be thousands of
    // tokens) clear of HTTP timeouts; finalMessage() gives back one Message.
    const stream = this.client.beta.messages.stream({
      model: request.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      thinking: { type: "adaptive" },
      output_config: { effort: request.effort },
      // Cache the growing conversation prefix: each turn of an agent loop
      // re-sends everything before it, so cache reads cut the input bill.
      cache_control: { type: "ephemeral" },
      // If a safety classifier declines the request, let the API retry it on
      // the model's default fallback instead of failing the whole run.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    return stream.finalMessage();
  }
}
