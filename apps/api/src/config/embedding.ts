import { z } from "zod";

/** 嵌入提供方枚举；配置校验、缺省地址与索引键共用这一份。 */
export const EMBEDDING_PROVIDERS = [
  "ollama",
  "openai",
  "voyage",
  "jina",
] as const;

export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export const DEFAULT_EMBEDDING_BASE_URL: Record<EmbeddingProvider, string> = {
  ollama: "http://localhost:11434",
  openai: "https://api.openai.com/v1",
  voyage: "https://api.voyageai.com/v1",
  jina: "https://api.jina.ai/v1",
};

/** 嵌入配置五元组：提供方、服务地址、模型、向量维度、分块版本。 */
export interface EmbeddingKeyConfig {
  provider: EmbeddingProvider;
  baseUrl: string;
  model: string;
  dimensions: number;
  chunking: string;
}

/** 索引键：外层为嵌入配置键与资料目录，内层为嵌入配置五元组。 */
export interface ParsedIndexKey {
  embeddingKey: string;
  embedding: EmbeddingKeyConfig;
  root: string;
}

export interface EmbeddingInfo {
  provider: EmbeddingProvider;
  model: string;
  baseUrl: string;
}

export function readEmbeddingInfo(
  env: NodeJS.ProcessEnv,
): EmbeddingInfo | null {
  if (!env.EMBEDDING_PROVIDER) return null;
  const config = z
    .object({
      EMBEDDING_PROVIDER: z.enum(EMBEDDING_PROVIDERS),
      EMBEDDING_MODEL: z.string().trim().min(1),
      EMBEDDING_BASE_URL: z.url().optional(),
    })
    .parse(env);
  return {
    provider: config.EMBEDDING_PROVIDER,
    model: config.EMBEDDING_MODEL,
    baseUrl:
      config.EMBEDDING_BASE_URL ??
      DEFAULT_EMBEDDING_BASE_URL[config.EMBEDDING_PROVIDER],
  };
}

export function formatIndexKey(embeddingKey: string, root: string) {
  return JSON.stringify([embeddingKey, root]);
}

export function parseIndexKey(key: string): ParsedIndexKey {
  const [embeddingKey, root] = z
    .tuple([z.string(), z.string()])
    .parse(JSON.parse(key) as unknown);
  const [provider, baseUrl, model, dimensions, chunking] = z
    .tuple([
      z.enum(EMBEDDING_PROVIDERS),
      z.string(),
      z.string(),
      z.number(),
      z.string(),
    ])
    .parse(JSON.parse(embeddingKey) as unknown);
  return {
    embeddingKey,
    embedding: { provider, baseUrl, model, dimensions, chunking },
    root,
  };
}
