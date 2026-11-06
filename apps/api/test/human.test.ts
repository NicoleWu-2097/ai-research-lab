import { PGlite } from "@electric-sql/pglite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { HumanStore } from "../src/human/store.js";
import { HumanService } from "../src/human/service.js";
import type { ModelProvider } from "../src/model/types.js";
import { chunkDocument } from "../src/rag/chunks.js";
import { createApp } from "../src/app.js";
const db = new PGlite();
const store = new HumanStore(db);
beforeAll(() => store.initialize());
afterAll(() => db.close());
function fixture(target = store, action = "local", reviews = ["approve"]) {
  const calls = { plan: 0, analyze: 0, critique: 0, generate: 0 };
  const provider: ModelProvider = {
    provider: "ollama",
    model: "fixture",
    async structuredOutput<T>(prompt: string) {
      let result: unknown;
      if (prompt.includes("Classify the next step")) {
        calls.plan++;
        result = {
          action,
          query: "followup",
          questions: ["为什么单库？"],
          reason: "需要证据",
        };
      } else if (prompt.includes("Analyze the research")) {
        calls.analyze++;
        result = {
          findings: [
            {
              kind: "observation",
              text: "一套服务",
              evidence: [{ sourceId: "RAG:1", quote: "one data service" }],
            },
          ],
          unresolved: [],
        };
      } else {
        calls.critique++;
        const verdict = reviews.shift() ?? "approve";
        result = {
          verdict,
          issues: verdict === "approve" ? [] : ["需要补充资料"],
          summary: "审查结果",
        };
      }
      return result as T;
    },
    async generate() {
      return "hello";
    },
    async *stream() {
      calls.generate++;
      yield "一套服务 [RAG:1]";
    },
  };
  const doc = {
    id: "test.md",
    content: "Use one data service.",
    sha256: "a".repeat(64),
    retrievedAt: new Date().toISOString(),
  };
  const local = {
    retrieve: vi.fn(async () => [{ ...chunkDocument(doc)[0]!, score: 0.9 }]),
  };
  const tools = { collect: vi.fn(async () => [doc]) };
  const service = () =>
    new HumanService(target, provider, 10000, local, tools, null, "config-v1");
  return { service, local, tools, calls, provider };
}
async function run(service: HumanService, id: string, key: string) {
  await service.start(id, key);
  await service.active.get(id);
  return service.store.read(id, key);
}
it("pauses before retrieval and resumes the approved snapshot without repeating planning", async () => {
  const f = fixture();
  const created = await store.create("original", "Alice", false, "config-v1");
  let task = await run(f.service(), created.task.id, created.key);
  expect(task.status).toBe("pending");
  expect(task.approval?.kind).toBe("plan");
  expect(f.local.retrieve).not.toHaveBeenCalled();
  await store.decide(
    task.id,
    created.key,
    task.approval!.id,
    "Bob",
    true,
    "adjusted query",
  );
  task = await run(f.service(), task.id, created.key);
  expect(task.status).toBe("completed");
  expect(task.report).toContain("原文");
  expect(f.calls.plan).toBe(1);
  expect(f.local.retrieve.mock.calls[0]).toEqual([
    "adjusted query",
    expect.any(AbortSignal),
  ]);
  expect(task.snapshot?.calls).toBe(4);
  expect(
    task.audit.some((e) => e.actor === "Bob" && e.action === "approved"),
  ).toBe(true);
});
it("supports clarification and rejects stale decisions without running tools", async () => {
  const f = fixture();
  const { task, key } = await store.create(
    "ambiguous",
    "Alice",
    true,
    "config-v1",
  );
  await store.decide(
    task.id,
    key,
    task.approval!.id,
    "Alice",
    true,
    "clear question",
  );
  const pending = await run(f.service(), task.id, key);
  expect(pending.question).toBe("clear question");
  expect(pending.approval?.query).toBe("clear question");
  await expect(
    store.decide(task.id, key, task.approval!.id, "Alice", true),
  ).rejects.toThrow();
  await store.decide(task.id, key, pending.approval!.id, "Alice", false);
  await expect(f.service().start(task.id, key)).rejects.toThrow();
  expect(f.local.retrieve).not.toHaveBeenCalled();
  expect((await store.read(task.id, key)).status).toBe("rejected");
});
it("gates MCP and supplemental plans separately", async () => {
  const f = fixture(store, "mcp");
  const { task, key } = await store.create("why", "Alice", false, "config-v1");
  const pending = await run(f.service(), task.id, key);
  expect(pending.approval?.kind).toBe("tool");
  expect(pending.approval?.reason).toContain("不写入");
  expect(f.tools.collect).not.toHaveBeenCalled();
  const g = fixture(store, "local", ["revise"]);
  const second = await store.create("first query", "Alice", false, "config-v1");
  const firstPlan = await run(g.service(), second.task.id, second.key);
  await store.decide(
    firstPlan.id,
    second.key,
    firstPlan.approval!.id,
    "Alice",
    true,
  );
  const secondPlan = await run(g.service(), firstPlan.id, second.key);
  expect(secondPlan.approval?.kind).toBe("plan_adjustment");
  expect(g.local.retrieve).toHaveBeenCalledTimes(1);
  await expect(
    store.decide(
      firstPlan.id,
      second.key,
      secondPlan.approval!.id,
      "Alice",
      true,
      "FIRST QUERY",
    ),
  ).rejects.toThrow("重复");
});
it("expires pending approvals and forbids wrong access keys", async () => {
  const expired = new HumanStore(db, -1);
  const { task, key } = await expired.create("why", "Alice", true, "config-v1");
  expect((await expired.read(task.id, key)).status).toBe("expired");
  await expect(
    expired.decide(task.id, key, task.approval!.id, "Alice", true),
  ).rejects.toThrow();
  await expect(store.read(task.id, "0".repeat(64))).rejects.toThrow();
});
it("does not replay uncertain in-flight work after its execution lease expires", async () => {
  const f = fixture();
  const { task, key } = await store.create("why", "Alice", false, "config-v1");
  const pending = await run(f.service(), task.id, key);
  await store.change(task.id, key, (t) => {
    t.status = "running";
    t.snapshot!.phase = "inflight";
    t.snapshot!.next = "research";
    t.leaseUntil = new Date(0).toISOString();
    return { actor: "test", action: "simulate_crash", detail: {} };
  });
  await f.service().start(task.id, key);
  expect((await store.read(task.id, key)).status).toBe("interrupted");
  expect(f.calls.plan).toBe(1);
  expect(f.local.retrieve).not.toHaveBeenCalled();
  expect(pending.snapshot?.phase).toBe("ready");
});
it("blocks configuration drift and repeated starts", async () => {
  const f = fixture();
  const { task, key } = await store.create(
    "why",
    "Alice",
    false,
    "other-config",
  );
  await expect(f.service().start(task.id, key)).rejects.toThrow("配置");
  const second = await store.create("why", "Alice", false, "config-v1");
  await store.change(second.task.id, second.key, (t) => {
    t.status = "running";
    t.leaseUntil = new Date(Date.now() + 10000).toISOString();
    return { actor: "test", action: "running", detail: {} };
  });
  await expect(f.service().start(second.task.id, second.key)).rejects.toThrow(
    "仍在执行",
  );
});
it("persists approvals across an actual database close and reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "human-restart-"));
  let disk = new PGlite(root);
  try {
    let persistent = new HumanStore(disk);
    await persistent.initialize();
    const created = await persistent.create("why", "Alice", false, "config-v1");
    const f = fixture(persistent);
    const pending = await run(f.service(), created.task.id, created.key);
    await disk.close();
    disk = new PGlite(root);
    persistent = new HumanStore(disk);
    await persistent.initialize();
    await persistent.decide(
      created.task.id,
      created.key,
      pending.approval!.id,
      "Bob",
      true,
    );
    const resumed = new HumanService(
      persistent,
      f.provider,
      10000,
      f.local,
      f.tools,
      null,
      "config-v1",
    );
    expect((await run(resumed, created.task.id, created.key)).status).toBe(
      "completed",
    );
    expect(f.calls.plan).toBe(1);
  } finally {
    await disk.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("exposes authenticated task endpoints and prevents the legacy stream bypass", async () => {
  const f = fixture();
  const human = f.service();
  const app = createApp(
    f.provider,
    10000,
    null,
    null,
    true,
    true,
    null,
    true,
    human,
  );
  const created = await app.request("/api/research/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "why", actor: "Alice", clarify: true }),
  });
  expect(created.status).toBe(201);
  const { id, key } = (await created.json()) as { id: string; key: string };
  const read = await app.request(`/api/research/tasks/${id}`, {
    headers: { "x-research-key": key },
  });
  const pending = (await read.json()) as { approval: { id: string } };
  const rejected = await app.request(`/api/research/tasks/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-research-key": key },
    body: JSON.stringify({ actor: "Bob", approvalId: pending.approval.id }),
  });
  expect(rejected.status).toBe(200);
  expect((await app.request(`/api/research/tasks/${id}`)).status).toBe(400);
  expect(
    (await app.request("/api/research/stream", { method: "POST" })).status,
  ).toBe(409);
  expect(
    (
      await app.request("/api/research/tasks", {
        method: "POST",
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
  ).toBe(403);
});
it("keeps execution time across approvals instead of granting a fresh budget", async () => {
  const f = fixture();
  const { task, key } = await store.create("why", "Alice", false, "config-v1");
  const pending = await run(f.service(), task.id, key);
  await store.change(task.id, key, (t) => {
    t.snapshot!.elapsedMs = 10000;
    return { actor: "test", action: "time_spent", detail: {} };
  });
  await store.decide(task.id, key, pending.approval!.id, "Alice", true);
  expect((await run(f.service(), task.id, key)).status).toBe("failed");
  expect(f.local.retrieve).not.toHaveBeenCalled();
});
