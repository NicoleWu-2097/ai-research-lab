import { z } from "zod";

export interface EmbeddingInfo {
  provider: "ollama" | "openai" | "voyage" | "jina";
  model: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = {
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com/v1",
  voyage: "https://api.voyageai.com/v1",
  jina: "https://api.jina.ai/v1",
} as const;

export function readEmbeddingInfo(
  env: NodeJS.ProcessEnv,
): EmbeddingInfo | null {
  if (!env.EMBEDDING_PROVIDER) return null;
  const config = z
    .object({
      EMBEDDING_PROVIDER: z.enum(["ollama", "openai", "voyage", "jina"]),
      EMBEDDING_MODEL: z.string().trim().min(1),
      EMBEDDING_BASE_URL: z.url().optional(),
    })
    .parse(env);
  return {
    provider: config.EMBEDDING_PROVIDER,
    model: config.EMBEDDING_MODEL,
    baseUrl:
      config.EMBEDDING_BASE_URL ?? DEFAULT_BASE_URL[config.EMBEDDING_PROVIDER],
  };
}
