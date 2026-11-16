import { describe, expect, it, vi } from "vitest";
import {
  createEmbedder,
  OpenAICompatibleEmbedder,
} from "../src/rag/embedding.js";

const signal = new AbortController().signal;

function adapter(
  provider: "openai" | "voyage" | "jina",
  fetchImpl: typeof fetch,
  dimensions = 2,
) {
  return new OpenAICompatibleEmbedder(
    {
      provider,
      baseUrl: `https://${provider}.example/v1`,
      apiKey: "test-only",
      model: "embed",
      dimensions,
    },
    fetchImpl,
  );
}

function captureBodies(embedding: number[] = [1, 2]) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ data: [{ index: 0, embedding }] });
  });
  return { bodies, fetchImpl };
}

describe("voyage adapter", () => {
  it("maps query and document kinds onto input_type", async () => {
    const { bodies, fetchImpl } = captureBodies();
    const embedder = adapter("voyage", fetchImpl);

    await embedder.embed(["query text"], "query", signal);
    await embedder.embed(["document text"], "document", signal);

    expect(bodies[0]).toMatchObject({
      model: "embed",
      input: ["query text"],
      input_type: "query",
      output_dimension: 2,
      truncation: false,
    });
    expect(bodies[1]).toMatchObject({
      model: "embed",
      input: ["document text"],
      input_type: "document",
      output_dimension: 2,
      truncation: false,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://voyage.example/v1/embeddings",
    );
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer test-only");
  });
});

describe("jina adapter", () => {
  it("maps query and document kinds onto task", async () => {
    const { bodies, fetchImpl } = captureBodies();
    const embedder = adapter("jina", fetchImpl);

    await embedder.embed(["query text"], "query", signal);
    await embedder.embed(["document text"], "document", signal);

    expect(bodies[0]).toMatchObject({
      model: "embed",
      input: ["query text"],
      task: "retrieval.query",
      dimensions: 2,
      truncate: false,
    });
    expect(bodies[1]).toMatchObject({
      model: "embed",
      input: ["document text"],
      task: "retrieval.passage",
      dimensions: 2,
      truncate: false,
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://jina.example/v1/embeddings",
    );
  });
});

describe("dimension validation", () => {
  it("reports the actual and expected dimensions", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        await Response.json({ data: [{ index: 0, embedding: [1, 2, 3] }] }),
    );
    const embedder = createEmbedder(
      {
        EMBEDDING_PROVIDER: "openai",
        EMBEDDING_MODEL: "embed",
        EMBEDDING_DIMENSIONS: "1024",
        OPENAI_API_KEY: "test-only",
      },
      fetchImpl,
    );

    await expect(embedder.embed(["hello"], "document", signal)).rejects.toThrow(
      /expected 1024 dimensions, received 3/,
    );
  });
});

describe("embedder configuration", () => {
  it("uses the provider default endpoint and EMBEDDING_API_KEY", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => await Response.json({ data: [{ index: 0, embedding: [1] }] }),
    );
    const embedder = createEmbedder(
      {
        EMBEDDING_PROVIDER: "voyage",
        EMBEDDING_MODEL: "voyage-4",
        EMBEDDING_DIMENSIONS: "1",
        EMBEDDING_API_KEY: "voyage-key",
      },
      fetchImpl,
    );

    expect(await embedder.embed(["hello"], "document", signal)).toEqual([[1]]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.voyageai.com/v1/embeddings",
    );
    expect(
      new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer voyage-key");
    expect(embedder.key).toContain("voyage-4");
    expect(() =>
      createEmbedder(
        {
          EMBEDDING_PROVIDER: "jina",
          EMBEDDING_MODEL: "jina-embeddings-v4",
          EMBEDDING_DIMENSIONS: "1024",
          EMBEDDING_API_KEY: "",
        },
        fetchImpl,
      ),
    ).toThrow(/Jina AI embeddings require EMBEDDING_API_KEY/);
  });
});

describe("ollama adapter", () => {
  it("uses the injected transport, disables truncation, and ignores kind", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: "embed",
        input: ["hello"],
        truncate: false,
      });
      return Response.json({ embeddings: [[1, 2, 3]] });
    });
    const embedder = createEmbedder(
      {
        EMBEDDING_PROVIDER: "ollama",
        EMBEDDING_MODEL: "embed",
        EMBEDDING_DIMENSIONS: "3",
      },
      fetchImpl,
    );

    expect(await embedder.embed(["hello"], "query", signal)).toEqual([
      [1, 2, 3],
    ]);
    expect(await embedder.embed(["hello"], "document", signal)).toEqual([
      [1, 2, 3],
    ]);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/api/embed");
  });
});

describe("abort handling", () => {
  it("rejects malformed vectors and aborts before contacting the provider", async () => {
    const request = vi.fn(
      async () => await Response.json({ embeddings: [[0, 0]] }),
    );
    const embedder = createEmbedder(
      {
        EMBEDDING_PROVIDER: "ollama",
        EMBEDDING_MODEL: "embed",
        EMBEDDING_DIMENSIONS: "2",
      },
      request,
    );

    await expect(embedder.embed(["hello"], "query", signal)).rejects.toThrow(
      "Invalid embedding",
    );
    request.mockClear();
    await expect(
      embedder.embed(
        ["hello"],
        "query",
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled");
    expect(request).not.toHaveBeenCalled();
  });
});

describe("retries", () => {
  it("retries rate limited requests twice before succeeding", async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls <= 2)
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      return Response.json({ data: [{ index: 0, embedding: [1, 2] }] });
    });
    const embedder = adapter("openai", fetchImpl);

    expect(await embedder.embed(["hello"], "query", signal)).toEqual([[1, 2]]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("gives up after two retries on server errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("unavailable", {
          status: 503,
          headers: { "retry-after": "0" },
        }),
    );
    const embedder = adapter("openai", fetchImpl);

    await expect(embedder.embed(["hello"], "query", signal)).rejects.toThrow(
      "503",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails immediately on a client error and keeps the status code", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response("bad request", { status: 400 }),
    );
    const embedder = adapter("openai", fetchImpl);

    await expect(embedder.embed(["hello"], "query", signal)).rejects.toThrow(
      "400",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("openai adapter", () => {
  it("sends no provider specific fields and orders vectors by index", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      });
    });
    const embedder = adapter("openai", fetchImpl);

    expect(await embedder.embed(["one", "two"], "document", signal)).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(bodies[0]).toMatchObject({
      model: "embed",
      input: ["one", "two"],
      encoding_format: "float",
    });
    for (const field of [
      "input_type",
      "output_dimension",
      "task",
      "dimensions",
      "truncation",
      "truncate",
    ]) {
      expect(bodies[0]).not.toHaveProperty(field);
    }
  });
});
