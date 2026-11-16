import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { VectorStore } from "../src/rag/store.js";
import { RagService } from "../src/rag/service.js";
import type { Embedder } from "../src/rag/embedding.js";

const signal = new AbortController().signal;
const uploadName = "工具约定.md";
const uploadContent = "MCP is a tool protocol.";
const uploadProject = "project-a";

function deterministic(key: string): Embedder {
  return {
    key,
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
}

const opened: { db: PGlite; root: string }[] = [];

async function setUp() {
  const db = new PGlite({ extensions: { vector } });
  const root = await mkdtemp(join(tmpdir(), "research-reindex-"));
  opened.push({ db, root });
  await writeFile(
    join(root, "storage.md"),
    "# Storage\nPostgreSQL keeps vectors and task data together.\n",
  );
  const store = new VectorStore(db);
  const previous = new RagService(
    store,
    deterministic("old-embedding-v1"),
    root,
  );
  await previous.ingest(signal);
  const upload = await previous.upload(
    uploadName,
    uploadContent,
    signal,
    uploadProject,
  );
  return {
    db,
    store,
    root,
    upload,
    next: new RagService(store, deterministic("new-embedding-v2"), root),
  };
}

afterEach(async () => {
  for (const { db, root } of opened.splice(0)) {
    await db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reindexes the corpus and uploaded documents under the new embedding configuration", async () => {
  const { upload, next } = await setUp();
  const configuration = await next.indexConfiguration();
  expect(configuration.current?.embeddingKey).toContain("old-embedding-v1");
  expect(configuration.next).toContain("new-embedding-v2");
  expect(await next.health()).toMatchObject({ compatible: false });

  const stats = await next.reindex(signal);

  expect(stats).toMatchObject({ documents: 2, chunks: 2, degraded: 0 });
  expect(stats.elapsedMs).toBeGreaterThanOrEqual(0);
  expect(await next.health()).toMatchObject({
    compatible: true,
    chunks: stats.chunks,
  });
  const corpus = await next.retrieve("PostgreSQL", signal);
  expect(corpus[0]).toMatchObject({ documentId: "storage.md" });
  const uploaded = await next.retrieve("MCP", signal);
  expect(uploaded[0]).toMatchObject({
    documentId: upload.id,
    projectId: uploadProject,
    filename: uploadName,
  });
  expect(uploaded[0]?.metadata).toMatchObject({
    source: uploadName,
    title: uploadName,
  });
  expect(await next.retrieve("MCP", signal, uploadProject)).toHaveLength(1);
});

it("keeps every stored document row when reindexing", async () => {
  const { store, next } = await setUp();
  const before = await store.listDocuments();
  expect(before).toHaveLength(1);

  await next.reindex(signal);

  expect(await store.listDocuments()).toEqual(before);
});

it("reports no current index before the first reindex", async () => {
  const db = new PGlite({ extensions: { vector } });
  const root = await mkdtemp(join(tmpdir(), "research-reindex-"));
  opened.push({ db, root });
  const service = new RagService(
    new VectorStore(db),
    deterministic("new-embedding-v2"),
    root,
  );

  const configuration = await service.indexConfiguration();

  expect(configuration.current).toBeNull();
  expect(configuration.next).toContain("new-embedding-v2");
});

it("counts a degraded document without aborting the corpus rebuild", async () => {
  const { store, root } = await setUp();
  const failing: Embedder = {
    key: "new-embedding-v2",
    dimensions: 3,
    async embed(texts) {
      if (texts.some((text) => text.includes("MCP")))
        throw new Error("embedding service offline");
      return texts.map((text) =>
        text.includes("PostgreSQL") ? [1, 0, 0] : [0, 0, 1],
      );
    },
  };
  const service = new RagService(store, failing, root);

  const stats = await service.reindex(signal);

  expect(stats).toMatchObject({ documents: 1, chunks: 1, degraded: 1 });
  expect(await store.listDocuments()).toHaveLength(1);
  expect((await service.retrieve("PostgreSQL", signal))[0]?.documentId).toBe(
    "storage.md",
  );
  expect((await service.health()).compatible).toBe(true);
});
