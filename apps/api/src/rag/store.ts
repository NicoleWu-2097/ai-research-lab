import { Pool, type PoolConfig } from "pg";
import type { Chunk, Hit } from "./chunks.js";

export interface Sql {
  query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
}

export function postgresDatabase(config: PoolConfig) {
  const pool = new Pool({
    ...config,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    idle_in_transaction_session_timeout: 15000,
  });
  const database: Database = {
    query: (sql, params) => pool.query(sql, params),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
  pool.on("error", () =>
    console.error(JSON.stringify({ event: "RAG_DATABASE_CONNECTION_FAILED" })),
  );
  return { database, close: () => pool.end() };
}

export interface StoredDocument {
  id: string;
  projectId: string;
  name: string;
  content: string;
  sha256: string;
  embeddingKey: string;
  updatedAt: string;
}

export class VectorStore {
  constructor(private readonly db: Database) {}
  async initialize() {
    await this.db.query("CREATE EXTENSION IF NOT EXISTS vector");
    await this.db.query(`CREATE TABLE IF NOT EXISTS rag_index (
      singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
      embedding_key text NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now()
    )`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS rag_chunks (
      id text PRIMARY KEY, metadata jsonb NOT NULL, embedding vector NOT NULL
    )`);
    await this.db.query(`CREATE TABLE IF NOT EXISTS rag_documents (
      project_id text NOT NULL,
      id text NOT NULL,
      name text NOT NULL,
      content text NOT NULL,
      sha256 text NOT NULL,
      embedding_key text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (project_id, id)
    )`);
  }
  async replace(
    key: string,
    chunks: Chunk[],
    vectors: number[][],
    signal: AbortSignal,
  ) {
    await this.db.transaction(async (sql) => {
      await sql.query("LOCK TABLE rag_index IN EXCLUSIVE MODE");
      signal.throwIfAborted();
      await sql.query("DELETE FROM rag_chunks");
      await sql.query("DELETE FROM rag_index");
      await sql.query("INSERT INTO rag_index (embedding_key) VALUES ($1)", [
        key,
      ]);
      for (const [index, chunk] of chunks.entries()) {
        signal.throwIfAborted();
        await sql.query(
          "INSERT INTO rag_chunks (id, metadata, embedding) VALUES ($1, $2::jsonb, $3::vector)",
          [chunk.id, JSON.stringify(chunk), JSON.stringify(vectors[index])],
        );
      }
      signal.throwIfAborted();
    });
  }
  async append(
    key: string,
    chunks: Chunk[],
    vectors: number[][],
    signal: AbortSignal,
    documentRecord?: StoredDocument,
  ) {
    await this.db.transaction(async (sql) => {
      await sql.query("LOCK TABLE rag_index IN EXCLUSIVE MODE");
      const { rows } = await sql.query<{ embedding_key: string }>(
        "SELECT embedding_key FROM rag_index",
      );
      if (rows[0] && rows[0].embedding_key !== key)
        throw new Error("Reingest before uploading");
      if (!rows[0])
        await sql.query("INSERT INTO rag_index (embedding_key) VALUES ($1)", [
          key,
        ]);
      if (documentRecord) {
        await sql.query(
          `INSERT INTO rag_documents (project_id, id, name, content, sha256, embedding_key, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (project_id, id) DO UPDATE
           SET name = EXCLUDED.name, content = EXCLUDED.content, sha256 = EXCLUDED.sha256, embedding_key = EXCLUDED.embedding_key, updated_at = now()`,
          [
            documentRecord.projectId,
            documentRecord.id,
            documentRecord.name,
            documentRecord.content,
            documentRecord.sha256,
            documentRecord.embeddingKey,
          ],
        );
      }
      for (const [i, chunk] of chunks.entries()) {
        signal.throwIfAborted();
        await sql.query(
          "INSERT INTO rag_chunks (id,metadata,embedding) VALUES ($1,$2::jsonb,$3::vector) ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding",
          [chunk.id, JSON.stringify(chunk), JSON.stringify(vectors[i])],
        );
      }
      signal.throwIfAborted();
    });
  }
  async deleteDocument(
    documentId: string,
    projectId?: string,
  ): Promise<{ deletedChunks: number }> {
    return this.db.transaction(async (sql) => {
      const { rows } = await sql.query<{ id: string; metadata: Chunk }>(
        "SELECT id, metadata FROM rag_chunks",
      );
      const toDelete = rows
        .filter((row) => {
          const matchesDoc =
            row.metadata.documentId === documentId || row.id === documentId;
          const matchesProj =
            !projectId ||
            !row.metadata.projectId ||
            row.metadata.projectId === projectId;
          return matchesDoc && matchesProj;
        })
        .map((row) => row.id);

      for (const chunkId of toDelete) {
        await sql.query("DELETE FROM rag_chunks WHERE id = $1", [chunkId]);
      }
      if (projectId) {
        await sql.query(
          "DELETE FROM rag_documents WHERE project_id = $1 AND id = $2",
          [projectId, documentId],
        );
      } else {
        await sql.query("DELETE FROM rag_documents WHERE id = $1", [
          documentId,
        ]);
      }
      return { deletedChunks: toDelete.length };
    });
  }
  async listChunks(key: string, projectId?: string): Promise<Chunk[]> {
    const { rows: index } = await this.db.query<{ embedding_key: string }>(
      "SELECT embedding_key FROM rag_index",
    );
    if (!index[0] || index[0].embedding_key !== key) return [];
    const { rows } = await this.db.query<{ metadata: Chunk }>(
      "SELECT metadata FROM rag_chunks ORDER BY id",
    );
    return rows
      .map((r) => r.metadata)
      .filter((chunk) => {
        if (!projectId) return true;
        // Include chunks explicitly belonging to projectId or shared default corpus ("default" / undefined)
        return !chunk.projectId || chunk.projectId === projectId;
      });
  }
  async getDocument(
    documentId: string,
    projectId = "default",
  ): Promise<StoredDocument | null> {
    const { rows } = await this.db.query<{
      project_id: string;
      id: string;
      name: string;
      content: string;
      sha256: string;
      embedding_key: string;
      updated_at: string;
    }>(
      "SELECT project_id, id, name, content, sha256, embedding_key, updated_at::text FROM rag_documents WHERE project_id = $1 AND id = $2",
      [projectId, documentId],
    );
    if (!rows[0]) return null;
    return {
      projectId: rows[0].project_id,
      id: rows[0].id,
      name: rows[0].name,
      content: rows[0].content,
      sha256: rows[0].sha256,
      embeddingKey: rows[0].embedding_key,
      updatedAt: rows[0].updated_at,
    };
  }
  async listDocuments(): Promise<StoredDocument[]> {
    const { rows } = await this.db.query<{
      project_id: string;
      id: string;
      name: string;
      content: string;
      sha256: string;
      embedding_key: string;
      updated_at: string;
    }>(
      "SELECT project_id, id, name, content, sha256, embedding_key, updated_at::text FROM rag_documents ORDER BY project_id, id",
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      id: row.id,
      name: row.name,
      content: row.content,
      sha256: row.sha256,
      embeddingKey: row.embedding_key,
      updatedAt: row.updated_at,
    }));
  }
  async currentIndex(): Promise<{
    embeddingKey: string;
    indexedAt: string;
  } | null> {
    const { rows } = await this.db.query<{
      embedding_key: string;
      indexed_at: string;
    }>("SELECT embedding_key, indexed_at::text FROM rag_index LIMIT 1");
    const row = rows[0];
    return row
      ? { embeddingKey: row.embedding_key, indexedAt: row.indexed_at }
      : null;
  }
  async health(key: string) {
    const { rows } = await this.db.query<{
      compatible: boolean;
      chunks: number;
      indexedAt: string;
    }>(
      `SELECT embedding_key = $1 AS compatible, indexed_at::text AS "indexedAt", (SELECT count(*)::int FROM rag_chunks) AS chunks FROM rag_index`,
      [key],
    );
    return rows[0] ?? { compatible: false, chunks: 0, indexedAt: null };
  }
  async search(
    key: string,
    vector: number[],
    limit: number,
    minScore: number,
    projectId?: string,
  ): Promise<Hit[]> {
    // One snapshot and an explicit key gate prevent cross-model vector comparisons.
    return this.db.transaction(async (sql) => {
      await sql.query("LOCK TABLE rag_index IN SHARE MODE");
      const { rows: index } = await sql.query<{ embedding_key: string }>(
        "SELECT embedding_key FROM rag_index",
      );
      if (index[0]?.embedding_key !== key)
        throw new Error("Reingest documents for this embedding configuration.");
      const fetchLimit = projectId ? Math.max(limit * 5, 25) : limit;
      const { rows } = await sql.query<{ metadata: Chunk; score: number }>(
        `SELECT metadata, 1 - (embedding <=> $1::vector) AS score FROM rag_chunks WHERE 1 - (embedding <=> $1::vector) >= $2 ORDER BY embedding <=> $1::vector, id LIMIT $3`,
        [JSON.stringify(vector), minScore, fetchLimit],
      );
      const filtered = projectId
        ? rows.filter(
            (row) =>
              !row.metadata.projectId || row.metadata.projectId === projectId,
          )
        : rows;
      return filtered.slice(0, limit).map((row) => ({
        ...row.metadata,
        score: row.score,
        retrievedAt: new Date().toISOString(),
      }));
    });
  }
}
