import { Ollama } from "ollama";
import { z } from "zod";

import {
  DEFAULT_EMBEDDING_BASE_URL,
  EMBEDDING_PROVIDERS,
  type EmbeddingProvider,
} from "../config/embedding.js";

export type EmbeddingKind = "query" | "document";

export interface Embedder {
  readonly key: string;
  readonly model: string;
  readonly dimensions: number;
  embed(
    texts: string[],
    kind: EmbeddingKind,
    signal: AbortSignal,
  ): Promise<number[][]>;
}

export function validateVectors(
  vectors: number[][],
  count: number,
  dimensions: number,
) {
  if (vectors.length !== count)
    throw new Error(
      `Invalid embedding count: expected ${count} vectors, received ${vectors.length}.`,
    );
  for (const vector of vectors) {
    if (vector.length !== dimensions)
      throw new Error(
        `Invalid embedding dimensions: expected ${dimensions} dimensions, received ${vector.length}.`,
      );
    if (vector.some((n) => !Number.isFinite(n)) || !vector.some((n) => n !== 0))
      throw new Error(
        `Invalid embedding values: expected ${dimensions} finite non-zero numbers.`,
      );
  }
  return vectors;
}

type CompatibleProvider = Exclude<EmbeddingProvider, "ollama">;

const PROVIDER_LABEL = {
  ollama: "Ollama",
  openai: "OpenAI",
  voyage: "Voyage AI",
  jina: "Jina AI",
} as const;

const MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;

function retryDelayMs(response: Response, attempt: number) {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  }
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface CompatibleEmbedderConfig {
  readonly provider: CompatibleProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly dimensions: number;
}

/** Transport shared by every provider exposing the OpenAI embeddings shape. */
export class OpenAICompatibleEmbedder {
  constructor(
    private readonly config: CompatibleEmbedderConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private requestBody(texts: string[], kind: EmbeddingKind) {
    const { provider, model, dimensions } = this.config;
    const body = { model, input: texts, encoding_format: "float" };
    if (provider === "voyage")
      return {
        ...body,
        input_type: kind === "query" ? "query" : "document",
        output_dimension: dimensions,
        truncation: false,
      };
    if (provider === "jina")
      return {
        ...body,
        task: kind === "query" ? "retrieval.query" : "retrieval.passage",
        dimensions,
        truncate: false,
      };
    return body;
  }

  async embed(
    texts: string[],
    kind: EmbeddingKind,
    signal: AbortSignal,
  ): Promise<number[][]> {
    signal.throwIfAborted();
    const body = JSON.stringify(this.requestBody(texts, kind));
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(
        `${this.config.baseUrl}/embeddings`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          signal,
        },
      );
      if (response.ok) return this.parse(response);
      if (
        !(response.status === 429 || response.status >= 500) ||
        attempt >= MAX_RETRIES
      )
        throw new Error(
          `Embedding request failed with status ${response.status}.`,
        );
      await wait(retryDelayMs(response, attempt), signal);
    }
  }

  private async parse(response: Response) {
    const payload = (await response.json()) as {
      data?: { index: number; embedding: number[] }[];
    };
    if (!Array.isArray(payload.data))
      throw new Error("Embedding response did not include vectors.");
    return payload.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }
}

async function embedWithOllama(
  model: string,
  host: string,
  fetchImpl: typeof fetch,
  texts: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const client = new Ollama({
    host,
    fetch: (input, init) => {
      const signals = [signal];
      if (init?.signal) signals.push(init.signal);
      return fetchImpl(input, { ...init, signal: AbortSignal.any(signals) });
    },
  });
  return (
    await client.embed({
      model,
      input: texts,
      truncate: false,
    })
  ).embeddings;
}

export function createEmbedder(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  const config = z
    .object({
      EMBEDDING_PROVIDER: z.enum(EMBEDDING_PROVIDERS),
      EMBEDDING_MODEL: z.string().trim().min(1),
      EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(16000),
      EMBEDDING_BASE_URL: z.url().optional(),
      EMBEDDING_API_KEY: z.string().trim().optional(),
      OPENAI_API_KEY: z.string().trim().optional(),
    })
    .parse(env);
  const provider = config.EMBEDDING_PROVIDER;
  const baseUrl =
    config.EMBEDDING_BASE_URL ?? DEFAULT_EMBEDDING_BASE_URL[provider];
  const apiKeyName =
    provider === "openai" ? "OPENAI_API_KEY" : "EMBEDDING_API_KEY";
  const apiKey =
    provider === "ollama"
      ? ""
      : provider === "openai"
        ? config.OPENAI_API_KEY
        : config.EMBEDDING_API_KEY;
  // 缺少密钥不阻塞启动，改为在请求时报错，由检索层降级并留下说明。
  const missingKey =
    provider !== "ollama" && !apiKey
      ? `${PROVIDER_LABEL[provider]} embeddings require ${apiKeyName}.`
      : null;
  const transport =
    provider === "ollama"
      ? null
      : new OpenAICompatibleEmbedder(
          {
            provider,
            baseUrl,
            apiKey: apiKey ?? "",
            model: config.EMBEDDING_MODEL,
            dimensions: config.EMBEDDING_DIMENSIONS,
          },
          fetchImpl,
        );
  return {
    key: JSON.stringify([
      provider,
      baseUrl,
      config.EMBEDDING_MODEL,
      config.EMBEDDING_DIMENSIONS,
      "chars900-overlap120-v1",
    ]),
    model: config.EMBEDDING_MODEL,
    dimensions: config.EMBEDDING_DIMENSIONS,
    async embed(texts, kind, signal) {
      if (missingKey) throw new Error(missingKey);
      const vectors = transport
        ? await transport.embed(texts, kind, signal)
        : await embedWithOllama(
            config.EMBEDDING_MODEL,
            baseUrl,
            fetchImpl,
            texts,
            signal,
          );
      return validateVectors(
        vectors,
        texts.length,
        config.EMBEDDING_DIMENSIONS,
      );
    },
  };
}
