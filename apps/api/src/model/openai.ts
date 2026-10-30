import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { z } from "zod";

import {
  MAX_OUTPUT_TOKENS,
  ModelError,
  toModelError,
  type ModelProvider,
} from "./types.js";

export class OpenAIProvider implements ModelProvider {
  readonly provider = "openai" as const;
  private readonly client: OpenAI;

  constructor(
    readonly model: string,
    apiKey: string,
    fetchImpl?: typeof fetch,
  ) {
    this.client = new OpenAI({
      apiKey,
      maxRetries: 0,
      ...(fetchImpl ? { fetch: fetchImpl } : {}),
    });
  }

  async generate(prompt: string, signal: AbortSignal): Promise<string> {
    try {
      const response = await this.client.responses.create(
        {
          model: this.model,
          input: prompt,
          max_output_tokens: MAX_OUTPUT_TOKENS,
        },
        { signal },
      );
      if (response.status === "incomplete")
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "Model output was incomplete.",
        );
      if (!response.output_text) {
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "The model returned no text.",
        );
      }
      return response.output_text;
    } catch (error) {
      throw toModelError(error, signal);
    }
  }

  async *stream(prompt: string, signal: AbortSignal): AsyncIterable<string> {
    try {
      const events = await this.client.responses.create(
        {
          model: this.model,
          input: prompt,
          stream: true,
          max_output_tokens: MAX_OUTPUT_TOKENS,
        },
        { signal },
      );
      let completed = false;
      for await (const event of events) {
        if (event.type === "response.output_text.delta") yield event.delta;
        if (event.type === "response.completed") completed = true;
        if (event.type === "response.failed") {
          throw new ModelError(
            "MODEL_PROVIDER_ERROR",
            "The model response failed.",
          );
        }
      }
      if (!completed) {
        throw new ModelError(
          "MODEL_PROVIDER_ERROR",
          "The model stream ended early.",
        );
      }
    } catch (error) {
      throw toModelError(error, signal);
    }
  }

  async structuredOutput<T>(
    prompt: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      const response = await this.client.responses.parse(
        {
          model: this.model,
          input: prompt,
          max_output_tokens: MAX_OUTPUT_TOKENS,
          text: { format: zodTextFormat(schema, "structured_result") },
        },
        { signal },
      );
      if (response.status === "incomplete")
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "Model output was incomplete.",
        );
      if (response.output_parsed == null) {
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "The model returned no structured output.",
        );
      }
      return response.output_parsed;
    } catch (error) {
      throw toModelError(error, signal);
    }
  }
}
