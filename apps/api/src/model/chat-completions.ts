import OpenAI from "openai";
import { z } from "zod";
import {
  MAX_OUTPUT_TOKENS,
  ModelError,
  toModelError,
  type ModelProvider,
} from "./types.js";
/** OpenAI-compatible gateways supporting the Chat Completions wire format. */
export class ChatCompletionsProvider implements ModelProvider {
  readonly provider = "openai" as const;
  private readonly client: OpenAI;
  constructor(
    readonly model: string,
    apiKey: string,
    baseURL: string,
    auth: "bearer" | "api-key",
    fetchImpl: typeof fetch = fetch,
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL,
      maxRetries: 0,
      fetch: (input, init) => {
        const headers = new Headers(init?.headers);
        if (auth === "api-key") {
          headers.delete("authorization");
          headers.set("api-key", apiKey);
        }
        return fetchImpl(input, { ...init, headers });
      },
    });
  }
  private async request(
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    signal: AbortSignal,
  ) {
    try {
      const response = await this.client.chat.completions.create(
        {
          model: this.model,
          messages,
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: false,
        },
        { signal },
      );
      const choice = response.choices[0];
      if (choice?.finish_reason === "length")
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "Model output reached its token limit.",
        );
      if (!choice?.message.content?.trim())
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "The model returned no text.",
        );
      return choice.message.content;
    } catch (error) {
      throw toModelError(error, signal);
    }
  }
  generate(prompt: string, signal: AbortSignal) {
    return this.request(
      [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: prompt },
      ],
      signal,
    );
  }
  async *stream(prompt: string, signal: AbortSignal) {
    try {
      const stream = await this.client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: "You are a helpful assistant" },
            { role: "user", content: prompt },
          ],
          max_tokens: MAX_OUTPUT_TOKENS,
          stream: true,
        },
        { signal },
      );
      let text = "";
      for await (const chunk of stream) {
        const choice = chunk.choices[0];
        if (choice?.finish_reason === "length")
          throw new ModelError(
            "MODEL_INVALID_OUTPUT",
            "Model output reached its token limit.",
          );
        const delta = choice?.delta.content;
        if (delta) {
          text += delta;
          yield delta;
        }
      }
      if (!text.trim())
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "The model returned no text.",
        );
    } catch (error) {
      throw toModelError(error, signal);
    }
  }
  async structuredOutput<T>(
    prompt: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const text = await this.request(
      [
        {
          role: "system",
          content: `Return only JSON matching this schema. No tools or Markdown fences. ${JSON.stringify(z.toJSONSchema(schema))}`,
        },
        { role: "user", content: prompt },
      ],
      signal,
    );
    try {
      return schema.parse(JSON.parse(text));
    } catch (error) {
      throw new ModelError(
        "MODEL_INVALID_OUTPUT",
        "The model returned invalid structured output.",
        { cause: error },
      );
    }
  }
}
