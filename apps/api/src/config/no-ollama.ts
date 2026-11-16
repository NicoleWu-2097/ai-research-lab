import { z } from "zod";

const PROVIDER_VARIABLES = ["LLM_PROVIDER", "EMBEDDING_PROVIDER"] as const;

export function assertNoOllama(env: NodeJS.ProcessEnv): void {
  const { OLLAMA_DISABLED } = z
    .object({ OLLAMA_DISABLED: z.enum(["true", "false"]).default("false") })
    .parse(env);
  if (OLLAMA_DISABLED !== "true") return;
  const ollama = PROVIDER_VARIABLES.filter((name) => env[name] === "ollama");
  if (ollama.length > 0)
    throw new Error(
      `OLLAMA_DISABLED is true, but these settings point at ollama: ${ollama.join(", ")}.`,
    );
}
