import { z } from "zod";

import { ModelError, type ModelProvider } from "./types.js";
import { OllamaProvider } from "./ollama.js";
import { OpenAIProvider } from "./openai.js";

const timeoutSchema = z.coerce
  .number()
  .int()
  .min(1)
  .max(600_000)
  .default(60_000);
const modelNameSchema = z.string().trim().min(1);

export type ModelConfig =
  | { provider: "ollama"; model: string; baseUrl: string; timeoutMs: number }
  | { provider: "openai"; model: string; apiKey: string; timeoutMs: number };

export function readModelConfig(env: NodeJS.ProcessEnv): ModelConfig | null {
  const provider = env.LLM_PROVIDER;
  if (!provider) return null;

  if (provider === "ollama") {
    const parsed = z
      .object({
        OLLAMA_MODEL: modelNameSchema,
        OLLAMA_BASE_URL: z.url().default("http://localhost:11434"),
        MODEL_TIMEOUT_MS: timeoutSchema,
      })
      .parse(env);
    return {
      provider,
      model: parsed.OLLAMA_MODEL,
      baseUrl: parsed.OLLAMA_BASE_URL,
      timeoutMs: parsed.MODEL_TIMEOUT_MS,
    };
  }

  if (provider === "openai") {
    const parsed = z
      .object({
        OPENAI_MODEL: modelNameSchema,
        OPENAI_API_KEY: z.string().trim().min(1),
        MODEL_TIMEOUT_MS: timeoutSchema,
      })
      .parse(env);
    return {
      provider,
      model: parsed.OPENAI_MODEL,
      apiKey: parsed.OPENAI_API_KEY,
      timeoutMs: parsed.MODEL_TIMEOUT_MS,
    };
  }

  throw new Error("LLM_PROVIDER must be 'ollama' or 'openai'.");
}

export function createModelProvider(config: ModelConfig): ModelProvider {
  switch (config.provider) {
    case "ollama":
      return new OllamaProvider(config.model, config.baseUrl);
    case "openai":
      return new OpenAIProvider(config.model, config.apiKey);
  }
}

export function requireModelProvider(
  provider: ModelProvider | null,
): ModelProvider {
  if (!provider) {
    throw new ModelError(
      "MODEL_NOT_CONFIGURED",
      "Set LLM_PROVIDER and its model settings.",
    );
  }
  return provider;
}
