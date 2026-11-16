import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { VectorStore } from "../src/rag/store.js";
import { RagService } from "../src/rag/service.js";
import { chunkDocument } from "../src/rag/chunks.js";
import { createEmbedder, type Embedder } from "../src/rag/embedding.js";
import { readDocument } from "../src/mcp/documents.js";
import { createApp } from "../src/app.js";
import type { ModelProvider } from "../src/model/types.js";

const db = new PGlite({ extensions: { vector } });
const store = new VectorStore(db);
const signal = new AbortController().signal;
let root: string;
const embedding: Embedder = {
  key: "deterministic-v1",
  dimensions: 3,
  async embed(texts) {
    return texts.map((text) =>
      text.includes("PostgreSQL")
        ? [1, 0, 0]
        : text.includes("MCP")
          ? [0, 1, 0]
          : [0, 0, 1],
    );
  },
};
let rag: RagService;
const model: ModelProvider = {
  provider: "ollama",
  model: "test",
  async generate() {
    throw new Error("unused");
  },
  async structuredOutput() {
    throw new Error("unused");
  },
  async *stream(prompt) {
    expect(prompt).toContain("untrusted evidence");
    const id = prompt.match(/"id":"(RAG:\d+)"/)?.[1];
    yield `Use PostgreSQL 【 ${id} 】 and [ ${id} ]`;
  },
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "research-rag-"));
  await writeFile(
    join(root, "storage.md"),
    "# Storage\nPostgreSQL keeps vectors and task data together.\n",
  );
  await writeFile(join(root, "tools.md"), "# Tools\nMCP is a tool protocol.\n");
  rag = new RagService(store, embedding, root, 0.5);
  await rag.ingest(signal);
}, 30000);
afterAll(async () => {
  await db.close();
  await rm(root, { recursive: true, force: true });
});

it("runs real pgvector SQL with deterministic ranking, threshold and location mapping", async () => {
  const hits = await rag.retrieve("Why PostgreSQL?", signal);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    documentId: "storage.md",
    score: 1,
    startLine: 1,
  });
  const doc = await readDocument(root, "storage.md");
  expect(hits[0]?.content).toBe(
    doc.content.slice(hits[0]?.start, hits[0]?.end),
  );
  expect(hits[0]?.sha256).toBe(doc.sha256);
  expect(await rag.retrieve("unknown topic", signal)).toEqual([]);
});

it("chunks long Unicode documents with overlap and stable IDs", () => {
  const doc = {
    id: "long.md",
    content: "中文🧪 paragraph\n".repeat(300),
    sha256: "a".repeat(64),
    retrievedAt: new Date().toISOString(),
  };
  const chunks = chunkDocument(doc);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
  expect(chunks.at(-1)?.end).toBe(doc.content.length);
  for (const chunk of chunks) {
    expect(chunk.content).toBe(doc.content.slice(chunk.start, chunk.end));
    expect(Buffer.from(chunk.content).toString("utf8")).toBe(chunk.content);
    expect(chunk.content.length).toBeLessThanOrEqual(900);
  }
  expect(chunkDocument(doc)).toEqual(chunks);
});

it("deduplicates and replaces the snapshot without accumulating stale chunks", async () => {
  await writeFile(
    join(root, "z-copy.md"),
    (await readDocument(root, "storage.md")).content,
  );
  const previous = (await rag.retrieve("PostgreSQL", signal))[0]!.id;
  expect(await rag.ingest(signal)).toMatchObject({
    documents: 2,
    duplicates: 1,
    chunks: 2,
  });
  expect((await rag.retrieve("PostgreSQL", signal))[0]!.id).toBe(previous);
  await rm(join(root, "z-copy.md"));
  await writeFile(join(root, "storage.md"), "PostgreSQL updated evidence.");
  await rag.ingest(signal);
  expect((await rag.retrieve("PostgreSQL", signal))[0]!.id).not.toBe(previous);
  expect(await rag.health()).toMatchObject({ compatible: true, chunks: 2 });
});

it("preserves the old index on invalid embeddings and transaction failures", async () => {
  const bad = new RagService(
    store,
    {
      ...embedding,
      async embed() {
        return [[NaN]];
      },
    },
    root,
  );
  await expect(bad.ingest(signal)).rejects.toThrow();
  const chunk = (await rag.retrieve("PostgreSQL", signal))[0]!;
  await expect(
    store.replace(
      embedding.key,
      [chunk, chunk],
      [
        [1, 0, 0],
        [1, 0, 0],
      ],
      signal,
    ),
  ).rejects.toThrow();
  expect(await rag.health()).toMatchObject({ chunks: 2 });
  expect((await rag.retrieve("PostgreSQL", signal))[0]?.id).toBe(chunk.id);
});

it("rejects incompatible embedding configurations and cancelled requests", async () => {
  const other = new RagService(
    store,
    { ...embedding, key: "different-model" },
    root,
  );
  expect(await other.health()).toMatchObject({ compatible: false });
  expect(
    await new RagService(
      store,
      embedding,
      join(root, "different-corpus"),
    ).health(),
  ).toMatchObject({ compatible: false });
  await expect(other.retrieve("PostgreSQL", signal)).rejects.toMatchObject({
    code: "RAG_FAILED",
  });
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  await expect(rag.ingest(controller.signal)).rejects.toThrow("cancelled");
  await expect(rag.retrieve("PostgreSQL", controller.signal)).rejects.toThrow(
    "cancelled",
  );
});

it("degrades to sparse hits with a reason when the embedding service fails", async () => {
  const unavailable = new RagService(
    store,
    {
      ...embedding,
      async embed() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
      },
    },
    root,
    0.5,
  );
  const result = await unavailable.retrieveWithStatus("PostgreSQL", signal);
  expect(result.degraded).toBe(true);
  expect(result.degradedReason).toContain("ECONNREFUSED");
  expect(result.hits.map((hit) => hit.documentId)).toContain("storage.md");
  const delegated = await unavailable.retrieve("PostgreSQL", signal);
  expect(delegated.map((hit) => hit.id)).toEqual(
    result.hits.map((hit) => hit.id),
  );
});

it("keeps the degraded marker when sparse retrieval finds nothing", async () => {
  const unavailable = new RagService(
    store,
    {
      ...embedding,
      async embed() {
        throw new Error("embedding service offline");
      },
    },
    root,
  );
  const result = await unavailable.retrieveWithStatus("kangaroo", signal);
  expect(result.hits).toEqual([]);
  expect(result.degraded).toBe(true);
  expect(result.degradedReason).toContain("offline");
});

it("degrades unified knowledge base retrieval without fabricating hits", async () => {
  const unavailable = new RagService(
    store,
    {
      ...embedding,
      async embed() {
        throw new Error("embedding service offline");
      },
    },
    root,
  );
  const hit = await unavailable.searchKnowledgeBase(
    { query: "PostgreSQL" },
    signal,
  );
  expect(hit.degraded).toBe(true);
  expect(hit.degradedReason).toContain("offline");
  expect(hit.hits.some((h) => h.documentId === "storage.md")).toBe(true);
  const empty = await unavailable.searchKnowledgeBase(
    { query: "kangaroo" },
    signal,
  );
  expect(empty.hits).toEqual([]);
  expect(empty.degraded).toBe(true);
});

it("reports no degradation when the embedding service responds", async () => {
  const single = await rag.retrieveWithStatus("PostgreSQL", signal);
  expect(single.degraded).toBe(false);
  expect(single.degradedReason).toBeUndefined();
  const unified = await rag.searchKnowledgeBase(
    { query: "PostgreSQL" },
    signal,
  );
  expect(unified.degraded).toBe(false);
  expect(unified.degradedReason).toBeUndefined();
});

it("still throws a retrieval error when the vector store fails", async () => {
  const deadDb = new PGlite({ extensions: { vector } });
  const deadStore = new VectorStore(deadDb);
  await deadDb.close();
  const growing = new RagService(deadStore, embedding, root);
  await expect(growing.retrieve("PostgreSQL", signal)).rejects.toMatchObject({
    code: "RAG_FAILED",
  });
  await expect(
    growing.searchKnowledgeBase({ query: "PostgreSQL" }, signal),
  ).rejects.toMatchObject({ code: "RAG_FAILED" });
  const degrading = new RagService(
    deadStore,
    {
      ...embedding,
      async embed() {
        throw new Error("embedding service offline");
      },
    },
    root,
  );
  await expect(
    degrading.retrieveWithStatus("PostgreSQL", signal),
  ).rejects.toMatchObject({ code: "RAG_FAILED" });
});

it("returns HTTP hits and streams only mapped citations to completion", async () => {
  const app = createApp(model, 10000, null, rag);
  expect((await app.request("/api/rag/health")).status).toBe(200);
  const request = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "PostgreSQL" }),
  };
  const retrieved = await app.request("/api/rag/retrieve", request);
  expect((await retrieved.json()).sources[0].documentId).toBe("storage.md");
  const response = await app.request("/api/research/stream", request);
  const text = await response.text();
  expect(text).toContain("RETRIEVAL_COMPLETED");
  expect(text).toContain("CITATIONS_VALIDATED");
  expect(text).toContain("AGENT_COMPLETED");
  expect(text).toContain("storage.md");
  expect(text).toContain('"report":"Use PostgreSQL [RAG:1] and [RAG:1]"');
  const retrieval = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .find((event) => event.type === "RETRIEVAL_COMPLETED");
  expect(retrieval.sources[0]).toMatchObject({
    id: "RAG:1",
    chunkId: (await rag.retrieve("PostgreSQL", signal))[0]!.id,
  });
});

it("terminates stalled retrieval at the research deadline", async () => {
  const stalled = new RagService(
    store,
    { ...embedding, embed: () => new Promise(() => undefined) },
    root,
  );
  const response = await createApp(model, 10, null, stalled).request(
    "/api/research/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "PostgreSQL" }),
    },
  );
  const text = await response.text();
  expect(text).toContain("MODEL_TIMEOUT");
  expect(text).not.toContain("AGENT_COMPLETED");
});

it("rejects invented and missing citations without a successful terminal event", async () => {
  for (const report of ["unsupported [RAG:invented]", "no citations"]) {
    const app = createApp(
      {
        ...model,
        async *stream() {
          yield report;
        },
      },
      10000,
      null,
      rag,
    );
    const response = await app.request("/api/research/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "PostgreSQL" }),
    });
    const text = await response.text();
    expect(text).toContain("MODEL_INVALID_OUTPUT");
    expect(text).not.toContain("AGENT_COMPLETED");
  }
});

it("explicitly reports insufficient evidence without model generation when nothing matches", async () => {
  const stream = vi.fn(model.stream);
  const response = await createApp(
    { ...model, stream },
    10000,
    null,
    rag,
  ).request("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "unknown topic" }),
  });
  expect(await response.text()).toContain("本地资料证据不足");
  expect(stream).not.toHaveBeenCalled();
});

it("keeps RAG disabled by default and validates retrieval input", async () => {
  const app = createApp(null);
  expect((await app.request("/api/rag/health")).status).toBe(503);
  expect(
    (
      await app.request("/api/rag/retrieve", {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(400);
});

it("validates embedding configuration independently from generation", async () => {
  const withoutKey = createEmbedder({
    EMBEDDING_PROVIDER: "openai",
    EMBEDDING_MODEL: "test",
    EMBEDDING_DIMENSIONS: "3",
  });
  await expect(
    withoutKey.embed(["probe"], "query", new AbortController().signal),
  ).rejects.toThrow(/OPENAI_API_KEY/);
  expect(
    createEmbedder({
      EMBEDDING_PROVIDER: "ollama",
      EMBEDDING_MODEL: "embed-only",
      EMBEDDING_DIMENSIONS: "3",
      OLLAMA_MODEL: "generation",
    }).key,
  ).toContain("embed-only");
});

it("removes deleted documents and supports an explicitly empty corpus on reingestion", async () => {
  await rm(join(root, "storage.md"));
  expect(await rag.ingest(signal)).toMatchObject({ documents: 1, chunks: 1 });
  expect(await rag.retrieve("PostgreSQL", signal)).toEqual([]);
  expect((await rag.retrieve("MCP", signal))[0]?.documentId).toBe("tools.md");
  await rm(join(root, "tools.md"));
  expect(await rag.ingest(signal)).toMatchObject({ documents: 0, chunks: 0 });
  expect(await rag.health()).toMatchObject({ compatible: true, chunks: 0 });
  expect(await rag.retrieve("MCP", signal)).toEqual([]);
});
it("uploads UTF-8 text through Hono, indexes it without deleting existing sources, and deduplicates repeat uploads", async () => {
  const app = createApp(model, 10000, null, rag);
  const send = () => {
    const form = new FormData();
    form.append(
      "file",
      new File(["PostgreSQL upload unique evidence."], "研究资料.txt"),
    );
    return app.request("http://localhost/api/rag/upload", {
      method: "POST",
      body: form,
    });
  };
  const first = await send();
  expect(first.status).toBe(201);
  const body = await first.json();
  expect(body.chunks).toBe(1);
  const hits = await rag.retrieve("PostgreSQL", signal);
  expect(hits.some((hit) => hit.documentId === body.id)).toBe(true);
  const count = (await rag.health()).chunks;
  expect((await send()).status).toBe(201);
  expect((await rag.health()).chunks).toBe(count);
});
it("rejects unsupported upload formats and foreign origins before indexing", async () => {
  const app = createApp(model, 10000, null, rag);
  const form = new FormData();
  form.append("file", new File(["binary"], "document.pdf"));
  expect(
    (
      await app.request("http://localhost/api/rag/upload", {
        method: "POST",
        body: form,
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request("http://localhost/api/rag/upload", {
        method: "POST",
        headers: { origin: "https://example.com" },
      })
    ).status,
  ).toBe(403);
});
it("probes the embedding service only when the health check asks for it", async () => {
  const calls: { texts: string[]; kind: string }[] = [];
  const probed = new RagService(
    store,
    {
      key: "deterministic-v1",
      dimensions: 3,
      async embed(texts, kind) {
        calls.push({ texts, kind });
        return texts.map(() => [1, 0, 0]);
      },
    },
    root,
  );
  const app = createApp(
    model,
    10000,
    null,
    probed,
    false,
    false,
    null,
    false,
    null,
    null,
    "voyage-4",
  );

  const plain = await app.request("/api/rag/health");
  expect(plain.status).toBe(200);
  expect((await plain.json()).probe).toBeUndefined();
  expect(calls).toHaveLength(0);

  const response = await app.request("/api/rag/health?probe=true");
  expect(response.status).toBe(200);
  expect((await response.json()).probe).toMatchObject({
    ok: true,
    model: "voyage-4",
    expectedDimensions: 3,
    actualDimensions: 3,
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.kind).toBe("query");
  expect(calls[0]!.texts.length).toBeGreaterThan(0);
});
it("reports a probed dimension mismatch with both dimensions", async () => {
  const app = createApp(
    model,
    10000,
    null,
    new RagService(
      store,
      {
        key: "deterministic-v1",
        dimensions: 3,
        async embed() {
          return [[1, 0]];
        },
      },
      root,
    ),
    false,
    false,
    null,
    false,
    null,
    null,
    "voyage-4",
  );

  const response = await app.request("/api/rag/health?probe=true");
  expect(response.status).toBe(200);
  const { probe } = await response.json();
  expect(probe).toMatchObject({
    ok: false,
    model: "voyage-4",
    expectedDimensions: 3,
    actualDimensions: 2,
  });
  expect(probe.error).toContain("expected 3");
  expect(probe.error).toContain("received 2");
});
it("reports a failed probe without failing the health check", async () => {
  const app = createApp(
    model,
    10000,
    null,
    new RagService(
      store,
      {
        ...embedding,
        async embed() {
          throw new Error("Embedding request failed with status 401.");
        },
      },
      root,
    ),
    false,
    false,
    null,
    false,
    null,
    null,
    "voyage-4",
  );

  const response = await app.request("/api/rag/health?probe=true");
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.status).toBe("ready");
  expect(body.probe).toMatchObject({
    ok: false,
    model: "voyage-4",
    expectedDimensions: 3,
  });
  expect(body.probe.error).toBe("Embedding request failed with status 401.");
});
it("explains an unavailable embedding service without exposing SDK details", async () => {
  const unavailable = new RagService(
    store,
    {
      ...embedding,
      async embed() {
        throw new TypeError("fetch failed", {
          cause: { code: "ECONNREFUSED" },
        });
      },
    },
    root,
  );
  const form = new FormData();
  form.append("file", new File(["valid text"], "notes.md"));
  const response = await createApp(model, 10000, null, unavailable).request(
    "http://localhost/api/rag/upload",
    { method: "POST", body: form },
  );
  expect(response.status).toBe(503);
  expect((await response.json()).error).toContain("ollama serve");
});
