import { Pool } from "pg";
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

export function postgresDatabase(url: string) {
  const pool = new Pool({
    connectionString: url,
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
  ): Promise<Hit[]> {
    // One snapshot and an explicit key gate prevent cross-model vector comparisons.
    return this.db.transaction(async (sql) => {
      await sql.query("LOCK TABLE rag_index IN SHARE MODE");
      const { rows: index } = await sql.query<{ embedding_key: string }>(
        "SELECT embedding_key FROM rag_index",
      );
      if (index[0]?.embedding_key !== key)
        throw new Error("Reingest documents for this embedding configuration.");
      const { rows } = await sql.query<{ metadata: Chunk; score: number }>(
        `SELECT metadata, 1 - (embedding <=> $1::vector) AS score FROM rag_chunks WHERE 1 - (embedding <=> $1::vector) >= $2 ORDER BY embedding <=> $1::vector, id LIMIT $3`,
        [JSON.stringify(vector), minScore, limit],
      );
      return rows.map((row) => ({
        ...row.metadata,
        score: row.score,
        retrievedAt: new Date().toISOString(),
      }));
    });
  }
}
