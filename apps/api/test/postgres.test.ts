import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresDatabase, VectorStore } from "../src/rag/store.js";
import { readDatabaseConfig } from "../src/rag/database-config.js";
import { chunkDocument } from "../src/rag/chunks.js";

// Opt-in integration test; all tables live in a unique, disposable schema.
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "external PostgreSQL / pgvector",
  () => {
    const schema = `rag_test_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof postgresDatabase>;
    let connection: ReturnType<typeof postgresDatabase>;
    let store: VectorStore;
    const signal = new AbortController().signal;
    const chunks = chunkDocument({
      id: "test.md",
      sha256: "a".repeat(64),
      content: "PostgreSQL evidence",
      retrievedAt: new Date().toISOString(),
    });

    beforeAll(async () => {
      const config = readDatabaseConfig({
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL!,
      });
      admin = postgresDatabase(config);
      await admin.database.query("CREATE EXTENSION IF NOT EXISTS vector");
      await admin.database.query(`CREATE SCHEMA ${schema}`);
      connection = postgresDatabase({
        ...config,
        options: `-c search_path=${schema},public`,
      });
      store = new VectorStore(connection.database);
      await store.initialize();
    });

    afterAll(async () => {
      await connection?.close();
      if (admin) {
        try {
          await admin.database.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        } finally {
          await admin.close();
        }
      }
    });

    it("persists and retrieves vectors through a real TCP connection", async () => {
      await store.replace("model-2d", chunks, [[1, 0]], signal);
      expect(await store.health("model-2d")).toMatchObject({
        compatible: true,
        chunks: 1,
      });
      expect((await store.search("model-2d", [1, 0], 4, 0.5))[0]).toMatchObject(
        { id: chunks[0]!.id, score: 1, documentId: "test.md" },
      );
      expect(await store.search("model-2d", [0, 1], 4, 0.5)).toEqual([]);
    });

    it("rolls back failed replacements and serializes readers with a writer", async () => {
      await expect(
        store.replace(
          "bad",
          [chunks[0]!, chunks[0]!],
          [
            [1, 0],
            [1, 0],
          ],
          signal,
        ),
      ).rejects.toThrow();
      expect(await store.health("model-2d")).toMatchObject({
        compatible: true,
        chunks: 1,
      });
      const writer = store.replace("model-3d", chunks, [[1, 0, 0]], signal);
      const reader = store
        .search("model-2d", [1, 0], 4, 0.5)
        .then((hits) => hits.length)
        .catch((error: Error) => error.message);
      await writer;
      // The reader sees one complete configuration or an explicit mismatch, never mixed dimensions.
      expect([
        1,
        "Reingest documents for this embedding configuration.",
      ]).toContain(await reader);
      expect(
        (await store.search("model-3d", [1, 0, 0], 4, 0.5))[0]?.score,
      ).toBe(1);
    });
  },
);
