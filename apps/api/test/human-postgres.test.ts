import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresDatabase } from "../src/rag/store.js";
import { HumanStore } from "../src/human/store.js";
describe.skipIf(!process.env.TEST_DATABASE_URL)(
  "human approvals over PostgreSQL TCP",
  () => {
    const schema = `human_test_${randomUUID().replaceAll("-", "")}`;
    let admin: ReturnType<typeof postgresDatabase>;
    let connection: ReturnType<typeof postgresDatabase>;
    let store: HumanStore;
    beforeAll(async () => {
      admin = postgresDatabase({
        connectionString: process.env.TEST_DATABASE_URL!,
      });
      await admin.database.query(`CREATE SCHEMA ${schema}`);
      connection = postgresDatabase({
        connectionString: process.env.TEST_DATABASE_URL!,
        options: `-c search_path=${schema},public`,
      });
      store = new HumanStore(connection.database);
      await store.initialize();
    });
    afterAll(async () => {
      await connection?.close();
      if (admin) {
        await admin.database.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.close();
      }
    });
    it("allows exactly one concurrent decision and persists it across reconnection", async () => {
      const { task, key } = await store.create("why", "Alice", true, "v1");
      const decisions = await Promise.allSettled([
        store.decide(task.id, key, task.approval!.id, "Bob", true, "clear"),
        store.decide(task.id, key, task.approval!.id, "Carol", false),
      ]);
      expect(decisions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      await connection.close();
      connection = postgresDatabase({
        connectionString: process.env.TEST_DATABASE_URL!,
        options: `-c search_path=${schema},public`,
      });
      store = new HumanStore(connection.database);
      const loaded = await store.read(task.id, key);
      expect(["ready", "rejected"]).toContain(loaded.status);
      expect(
        loaded.audit.filter((e) =>
          ["approved", "rejected"].includes(String(e.action)),
        ),
      ).toHaveLength(1);
    });
  },
);
