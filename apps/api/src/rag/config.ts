import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createEmbedder } from "./embedding.js";
import { VectorStore } from "./store.js";
import { RagService } from "./service.js";
import { createDatabase } from "./database.js";

export function createRag(env: NodeJS.ProcessEnv) {
  const config = z
    .object({
      RAG_DOCUMENT_ROOT: z.string().min(1).optional(),
      RAG_MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.4),
    })
    .parse(env);
  const embedder = createEmbedder(env);
  const database = createDatabase(env);
  return {
    service: new RagService(
      new VectorStore(database.database),
      embedder,
      config.RAG_DOCUMENT_ROOT
        ? resolve(config.RAG_DOCUMENT_ROOT)
        : fileURLToPath(new URL("../../../../docs/decisions", import.meta.url)),
      config.RAG_MIN_SCORE,
    ),
    close: database.close,
  };
}
