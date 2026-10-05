import { Ollama } from "ollama";
import { z } from "zod";

import { ModelError, toModelError, type ModelProvider } from "./types.js";

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
      });
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
        stream: true,
      });
      let completed = false;
      try {
        for await (const event of events) {
          if (event.message.content) yield event.message.content;
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
      const response = await this.client(signal).chat({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        format: z.toJSONSchema(schema, { target: "draft-7" }),
      });
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
