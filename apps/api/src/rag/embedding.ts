import OpenAI from "openai";
import { Ollama } from "ollama";
import { z } from "zod";

export interface Embedder {
  readonly key: string;
  readonly dimensions: number;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

export function validateVectors(
  vectors: number[][],
  count: number,
  dimensions: number,
) {
  if (
    vectors.length !== count ||
    vectors.some(
      (v) =>
        v.length !== dimensions ||
        v.some((n) => !Number.isFinite(n)) ||
        !v.some((n) => n !== 0),
    )
  )
    throw new Error("Invalid embedding dimensions or values.");
  return vectors;
}

export function createEmbedder(env: NodeJS.ProcessEnv): Embedder {
  const config = z
    .object({
      EMBEDDING_PROVIDER: z.enum(["ollama", "openai"]),
      EMBEDDING_MODEL: z.string().trim().min(1),
      EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(16000),
      EMBEDDING_BASE_URL: z.url().optional(),
      OPENAI_API_KEY: z.string().min(1).optional(),
    })
    .parse(env);
  if (config.EMBEDDING_PROVIDER === "openai" && !config.OPENAI_API_KEY)
    throw new Error("OpenAI embeddings require OPENAI_API_KEY.");
  const endpoint =
    config.EMBEDDING_BASE_URL ??
    (config.EMBEDDING_PROVIDER === "ollama"
      ? "http://localhost:11434"
      : "https://api.openai.com/v1");
  return {
    key: JSON.stringify([
      config.EMBEDDING_PROVIDER,
      endpoint,
      config.EMBEDDING_MODEL,
      config.EMBEDDING_DIMENSIONS,
      "chars900-overlap120-v1",
    ]),
    dimensions: config.EMBEDDING_DIMENSIONS,
    async embed(texts, signal) {
      signal.throwIfAborted();
      let vectors: number[][];
      if (config.EMBEDDING_PROVIDER === "openai") {
        const client = new OpenAI({
          apiKey: config.OPENAI_API_KEY!,
          baseURL: endpoint,
          maxRetries: 0,
        });
        const response = await client.embeddings.create(
          {
            model: config.EMBEDDING_MODEL,
            input: texts,
            encoding_format: "float",
          },
          { signal },
        );
        vectors = response.data
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);
      } else {
        const client = new Ollama({
          host: endpoint,
          fetch: (input, init) =>
            fetch(input, {
              ...init,
              signal: init?.signal
                ? AbortSignal.any([signal, init.signal])
                : signal,
            }),
        });
        vectors = (
          await client.embed({
            model: config.EMBEDDING_MODEL,
            input: texts,
            truncate: false,
          })
        ).embeddings;
      }
      return validateVectors(
        vectors,
        texts.length,
        config.EMBEDDING_DIMENSIONS,
      );
    },
  };
}
