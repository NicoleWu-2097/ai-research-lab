import { existsSync } from "node:fs";
import { createRag } from "./config.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const rag = createRag(process.env);
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Reindex cancelled."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

function summarize(embeddingKey: string, indexedAt?: string) {
  const [provider, baseUrl, model, dimensions, chunking] = JSON.parse(
    embeddingKey,
  ) as [string, string, string, number, string];
  return {
    provider,
    baseUrl,
    model,
    dimensions,
    chunking,
    ...(indexedAt ? { indexedAt } : {}),
  };
}

try {
  const configuration = await rag.service.indexConfiguration();
  console.info(
    JSON.stringify({
      event: "RAG_REINDEX_CONFIGURATION",
      current: configuration.current
        ? summarize(
            configuration.current.embeddingKey,
            configuration.current.indexedAt,
          )
        : null,
      next: summarize(configuration.next),
      note: "索引是全局单例，本次重灌会按下一组配置替换现有索引，并重新处理资料目录与已上传文档。",
    }),
  );
  console.info(
    JSON.stringify({
      event: "RAG_REINDEX_COMPLETED",
      ...(await rag.service.reindex(
        AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
      )),
    }),
  );
} catch {
  console.error(
    "RAG reindex failed; check database, documents, embedding service and dimensions.",
  );
  process.exitCode = 1;
} finally {
  await rag.close();
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
