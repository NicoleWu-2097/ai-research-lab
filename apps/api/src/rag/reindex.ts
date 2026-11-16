import { parseIndexKey } from "../config/embedding.js";
import { runRagScript } from "./script.js";

function summarize(embeddingKey: string, indexedAt?: string) {
  const { embedding } = parseIndexKey(embeddingKey);
  return {
    provider: embedding.provider,
    baseUrl: embedding.baseUrl,
    model: embedding.model,
    dimensions: embedding.dimensions,
    chunking: embedding.chunking,
    ...(indexedAt ? { indexedAt } : {}),
  };
}

await runRagScript(
  "Reindex",
  "RAG reindex failed; check database, documents, embedding service and dimensions.",
  async (rag, signal) => {
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
        ...(await rag.service.reindex(signal)),
      }),
    );
  },
);
