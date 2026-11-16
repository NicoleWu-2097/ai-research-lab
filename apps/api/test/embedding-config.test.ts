import { describe, expect, it } from "vitest";

import { readEmbeddingInfo } from "../src/config/embedding.js";

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
