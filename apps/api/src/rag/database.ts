import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { z } from "zod";
import { readDatabaseConfig } from "./database-config.js";
import { postgresDatabase, type Database } from "./store.js";

// 数据库驱动：postgres 连接外部服务，pglite 在本地目录里运行同一个引擎。
export function createDatabase(env: NodeJS.ProcessEnv) {
  const config = z
    .object({
      DATABASE_DRIVER: z.enum(["postgres", "pglite"]).default("postgres"),
      PGLITE_DATA_DIR: z.string().min(1).default(".pglite"),
    })
    .parse(env);
  if (config.DATABASE_DRIVER === "postgres") {
    const postgres = postgresDatabase(readDatabaseConfig(env));
    return { database: postgres.database, close: postgres.close };
  }
  const pglite = new PGlite(resolve(config.PGLITE_DATA_DIR), {
    extensions: { vector },
  });
  // PGlite 只有一条连接，事务之间不能交错；按顺序排队执行每条语句和一个事务。
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(work: () => Promise<T>) {
    const run = pending.then(work, work);
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  const database: Database = {
    query: (sql, params) => serialize(() => pglite.query(sql, params)),
    transaction: (work) =>
      serialize(() => pglite.transaction((tx) => work(tx))),
  };
  return { database, close: () => pglite.close() };
}
