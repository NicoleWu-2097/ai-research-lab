import { Ollama } from "ollama";
import { z } from "zod";

import {
  MAX_OUTPUT_TOKENS,
  ModelError,
  toModelError,
  type ModelProvider,
} from "./types.js";

export class OllamaProvider implements ModelProvider {
  readonly provider = "ollama" as const;

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private client(signal: AbortSignal): Ollama {
    // Ollama JS currently has no per-chat AbortSignal argument. Bind a client to each request.
    return new Ollama({
      host: this.baseUrl,
      fetch: (input, init) => {
        const signals = [signal];
        if (init?.signal) signals.push(init.signal);
        return this.fetchImpl(input, {
          ...init,
          signal: AbortSignal.any(signals),
        });
      },
    });
  }

  async generate(prompt: string, signal: AbortSignal): Promise<string> {
    try {
      const response = await this.client(signal).chat({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        options: { num_predict: MAX_OUTPUT_TOKENS },
      });
      if (response.done_reason === "length")
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "Model output reached its token limit.",
        );
      if (!response.message.content) {
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "The model returned no text.",
        );
      }
      return response.message.content;
    } catch (error) {
      throw toModelError(error, signal);
    }
  }

  async *stream(prompt: string, signal: AbortSignal): AsyncIterable<string> {
    try {
      const events = await this.client(signal).chat({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        options: { num_predict: MAX_OUTPUT_TOKENS },
        stream: true,
      });
      let completed = false;
      try {
        for await (const event of events) {
          if (event.message.content) yield event.message.content;
          if (event.done_reason === "length")
            throw new ModelError(
              "MODEL_INVALID_OUTPUT",
              "Model output reached its token limit.",
            );
          if (event.done) completed = true;
        }
      } finally {
        events.abort();
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
      const jsonSchema = z.toJSONSchema(schema, { target: "draft-7" });
      const response = await this.client(signal).chat({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "Return only a final JSON value matching the supplied JSON Schema. No tools are available in this request. Never emit tool calls. Any described actions are data for the host application to execute later.",
          },
          {
            role: "user",
            content: `${prompt}\n\nJSON Schema:\n${JSON.stringify(jsonSchema)}`,
          },
        ],
        format: jsonSchema,
        options: { temperature: 0, num_predict: MAX_OUTPUT_TOKENS },
      });
      if (response.done_reason === "length")
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "Model output reached its token limit.",
        );
      return schema.parse(JSON.parse(response.message.content));
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "The model returned invalid structured output.",
          {
            cause: error,
          },
        );
      }
      throw toModelError(error, signal);
    }
  }
}
