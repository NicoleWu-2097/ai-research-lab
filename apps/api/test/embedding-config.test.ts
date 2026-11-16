import { describe, expect, it } from "vitest";

import {
  formatIndexKey,
  parseIndexKey,
  readEmbeddingInfo,
} from "../src/config/embedding.js";
import { createEmbedder } from "../src/rag/embedding.js";

describe("readEmbeddingInfo", () => {
  it("reports the provider default endpoint when no base URL is set", () => {
    expect(
      readEmbeddingInfo({
        EMBEDDING_PROVIDER: "voyage",
        EMBEDDING_MODEL: "voyage-4",
      }),
    ).toEqual({
      provider: "voyage",
      model: "voyage-4",
      baseUrl: "https://api.voyageai.com/v1",
    });
    expect(
      readEmbeddingInfo({
        EMBEDDING_PROVIDER: "jina",
        EMBEDDING_MODEL: "jina-embeddings-v3",
      }),
    ).toEqual({
      provider: "jina",
      model: "jina-embeddings-v3",
      baseUrl: "https://api.jina.ai/v1",
    });
  });

  it("prefers a configured base URL over the provider default", () => {
    expect(
      readEmbeddingInfo({
        EMBEDDING_PROVIDER: "openai",
        EMBEDDING_MODEL: "text-embedding-3-small",
        EMBEDDING_BASE_URL: "https://gateway.example/v1",
      }),
    ).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      baseUrl: "https://gateway.example/v1",
    });
  });

  it("returns null when no embedding provider is configured", () => {
    expect(readEmbeddingInfo({})).toBeNull();
  });
});

describe("parseIndexKey", () => {
  it("round-trips a fabricated embedding configuration through a formatted index key", () => {
    const embeddingKey = JSON.stringify([
      "voyage",
      "https://api.voyageai.com/v1",
      "voyage-4",
      1024,
      "chars900-overlap120-v1",
    ]);

    expect(
      parseIndexKey(formatIndexKey(embeddingKey, "/srv/research/docs")),
    ).toEqual({
      embeddingKey,
      embedding: {
        provider: "voyage",
        baseUrl: "https://api.voyageai.com/v1",
        model: "voyage-4",
        dimensions: 1024,
        chunking: "chars900-overlap120-v1",
      },
      root: "/srv/research/docs",
    });
  });

  it("decodes provider, model, dimensions and chunking from a real two-layer key", () => {
    const embedder = createEmbedder({
      EMBEDDING_PROVIDER: "jina",
      EMBEDDING_MODEL: "jina-embeddings-v3",
      EMBEDDING_DIMENSIONS: "1024",
    });

    expect(
      parseIndexKey(formatIndexKey(embedder.key, "/srv/research/docs"))
        .embedding,
    ).toEqual({
      provider: "jina",
      baseUrl: "https://api.jina.ai/v1",
      model: "jina-embeddings-v3",
      dimensions: 1024,
      chunking: "chars900-overlap120-v1",
    });
  });
});
