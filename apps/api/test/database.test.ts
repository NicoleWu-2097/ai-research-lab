import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDatabase } from "../src/rag/database.js";

const directories: string[] = [];

function tempDirectory() {
  const directory = mkdtempSync(join(process.cwd(), ".pglite-test-"));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories)
    rmSync(directory, { recursive: true, force: true });
});

describe("pglite driver", () => {
  it("persists rows across close and reopen", async () => {
    const directory = tempDirectory();
    const first = createDatabase({
      DATABASE_DRIVER: "pglite",
      PGLITE_DATA_DIR: directory,
    });
    await first.database.query(
      "create table notes (id int primary key, body text)",
    );
    await first.database.query("insert into notes values ($1, $2)", [
      1,
      "hello",
    ]);
    await first.close();

    const second = createDatabase({
      DATABASE_DRIVER: "pglite",
      PGLITE_DATA_DIR: directory,
    });
    const result = await second.database.query<{ body: string }>(
      "select body from notes",
    );
    expect(result.rows).toEqual([{ body: "hello" }]);
    await second.close();
  });

  it("runs transactions with the vector extension available", async () => {    const directory = tempDirectory();
    const { database, close } = createDatabase({
      DATABASE_DRIVER: "pglite",
      PGLITE_DATA_DIR: directory,
    });
    const rows = await database.transaction(async (sql) => {
      await sql.query("create extension if not exists vector");
      const result = await sql.query<{ value: number }>(
        "select 1::int as value",
      );
      return result.rows;
    });
    expect(rows).toEqual([{ value: 1 }]);
    await close();
  });
  it("serializes concurrent transactions on the single connection", async () => {
    const directory = tempDirectory();
    const { database, close } = createDatabase({
      DATABASE_DRIVER: "pglite",
      PGLITE_DATA_DIR: directory,
    });
    await database.query(
      "create table counter (id int primary key, value int not null)",
    );
    await database.query("insert into counter values (1, 0)");
    await Promise.all(
      Array.from({ length: 10 }, () =>
        database.transaction(async (sql) => {
          const { rows } = await sql.query<{ value: number }>(
            "select value from counter where id = 1 for update",
          );
          await sql.query("update counter set value = $1 where id = 1", [
            rows[0]!.value + 1,
          ]);
        }),
      ),
    );
    const { rows } = await database.query<{ value: number }>(
      "select value from counter where id = 1",
    );
    expect(rows[0]!.value).toBe(10);
    await close();
  });
});

describe("driver selection", () => {
  it("defaults to the postgres driver", async () => {
    const { database, close } = createDatabase({
      DATABASE_URL: "postgresql://research:local@127.0.0.1:5432/research",
    });
    expect(typeof database.query).toBe("function");
    expect(typeof database.transaction).toBe("function");
    await close();
  });
});
