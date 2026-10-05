import { afterEach, expect, it, vi } from "vitest";
import { createEmbedder } from "../src/rag/embedding.js";

afterEach(() => vi.unstubAllGlobals());

it("uses Ollama's embedding endpoint without silently truncating documents", async () => {
  const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "embed",
      input: ["hello"],
      truncate: false,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json({ embeddings: [[1, 2, 3]] });
  });
  vi.stubGlobal("fetch", request);
  const embedder = createEmbedder({
    EMBEDDING_PROVIDER: "ollama",
    EMBEDDING_MODEL: "embed",
    EMBEDDING_DIMENSIONS: "3",
  });
  expect(await embedder.embed(["hello"], new AbortController().signal)).toEqual(
    [[1, 2, 3]],
  );
  expect(String(request.mock.calls[0]?.[0])).toContain("/api/embed");
});

it("orders OpenAI embeddings by input index and requests float vectors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "embed",
        encoding_format: "float",
        input: ["one", "two"],
      });
      return Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      });
    }),
  );
  const embedder = createEmbedder({
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "embed",
    EMBEDDING_DIMENSIONS: "2",
    OPENAI_API_KEY: "test-only",
  });
  expect(
    await embedder.embed(["one", "two"], new AbortController().signal),
  ).toEqual([
    [1, 0],
    [0, 1],
  ]);
});

it("rejects malformed vectors and aborts before contacting the provider", async () => {
  const request = vi.fn(async () => Response.json({ embeddings: [[0, 0]] }));
  vi.stubGlobal("fetch", request);
  const embedder = createEmbedder({
    EMBEDDING_PROVIDER: "ollama",
    EMBEDDING_MODEL: "embed",
    EMBEDDING_DIMENSIONS: "2",
  });
  await expect(
    embedder.embed(["hello"], new AbortController().signal),
  ).rejects.toThrow("Invalid embedding");
  request.mockClear();
  await expect(
    embedder.embed(["hello"], AbortSignal.abort(new Error("cancelled"))),
  ).rejects.toThrow("cancelled");
  expect(request).not.toHaveBeenCalled();
});
