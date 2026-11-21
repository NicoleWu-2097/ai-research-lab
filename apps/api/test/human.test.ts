import { humanRoutes } from "../src/human/routes.js";
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
  let currentGoal = "";
  const calls = { intent: 0, plan: 0, analyze: 0, critique: 0, generate: 0 };
  const provider: ModelProvider = {
    provider: "ollama",
    model: "fixture",
    async structuredOutput<T>(prompt: string) {
      let result: unknown;
      if (prompt.includes("Route the project message")) {
        calls.intent++;
        const input = JSON.parse(prompt.split("\n").at(-1)!);
        currentGoal = input.clarification ?? input.message;
        result = { intent: "research", goal: currentGoal, clarification: "" };
      } else if (prompt.includes("Classify the next step")) {
        calls.plan++;
        result = {
          action,
          query: calls.plan === 1 ? currentGoal : "followup",
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
  expect(task.approval?.goal).toBe("original");
  expect(task.approval?.serves).toBe("为什么单库？");
  expect(task.approval?.reason).toContain("这一跳回答：为什么单库？");
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
  expect(task.snapshot?.calls).toBe(5);
  expect(f.calls.intent).toBe(1);
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
it("preserves actionable citation failure diagnostics instead of only a generic failure", async () => {
  const f = fixture();
  const created = await store.create("question", "Alice", false, "config-v1");
  let task = await run(f.service(), created.task.id, created.key);
  await store.decide(task.id, created.key, task.approval!.id, "Alice", true);
  f.provider.stream = async function* () {
    yield "没有任何片段引用的草稿";
  };
  task = await run(f.service(), task.id, created.key);
  expect(task.status).toBe("completed");
  expect(
    task.audit.some((event) => event.action === "CITATIONS_UNVERIFIED"),
  ).toBe(true);
  expect(task.report).toBeTruthy();
});
it("continues a project with archived report context and rejects overlapping turns", async () => {
  const f = fixture();
  const created = await store.create(
    "initial question",
    "Alice",
    false,
    "config-v1",
  );
  let task = await run(f.service(), created.task.id, created.key);
  await expect(
    store.followup(task.id, created.key, "too soon", "Alice"),
  ).rejects.toThrow();
  await store.decide(task.id, created.key, task.approval!.id, "Alice", true);
  task = await run(f.service(), task.id, created.key);
  const report = task.report;
  await store.followup(task.id, created.key, "make it shorter", "Alice");
  const providerCall = vi.spyOn(f.provider, "structuredOutput");
  task = await run(f.service(), task.id, created.key);
  expect(task.id).toBe(created.task.id);
  expect(task.history?.[0]?.report).toBe(report);
  expect(task.question).toBe("make it shorter");
  expect(providerCall.mock.calls[0]?.[0]).toContain(
    JSON.stringify(report).slice(1, -1),
  );
  expect(task.status).toBe("pending");
  expect(task.approval?.query).toBe("followup");
  expect(task.snapshot?.calls).toBe(2);
  await store.decide(task.id, created.key, task.approval!.id, "Alice", true);
  task = await run(f.service(), task.id, created.key);
  expect(task.status).toBe("completed");
  expect(f.local.retrieve).toHaveBeenLastCalledWith(
    "followup",
    expect.any(AbortSignal),
  );
});

it("normalizes legacy projects with stable turn/event identities without losing history", async () => {
  const created = await store.create(
    "legacy latest",
    "Alice",
    true,
    "config-v1",
  );
  const legacy = {
    ...created.task,
    turn: undefined,
    report: "latest retained",
    status: "completed",
    history: [
      {
        question: "legacy original",
        report: "older retained",
        snapshot: null,
        status: "completed",
        completedAt: created.task.createdAt,
      },
    ],
  };
  await db.query("UPDATE human_tasks SET data=$2::jsonb WHERE id=$1", [
    created.task.id,
    JSON.stringify(legacy),
  ]);
  const first = await store.read(created.task.id, created.key);
  const second = await store.read(created.task.id, created.key);
  expect(first.turn).toEqual(second.turn);
  expect(first.audit.map((e) => e.id)).toEqual(second.audit.map((e) => e.id));
  expect(first.history?.[0]?.report).toBe("older retained");
  expect(first.turn).toMatchObject({
    message: "legacy latest",
    intent: null,
    goal: null,
    query: null,
    basedOnReportId: first.history?.[0]?.turn.report.id,
    basedOnReportRevision: 1,
    report: { quality: "unreviewed" },
  });
  await store.followup(first.id, created.key, "总结一下你的研究", "Alice");
  const next = await store.read(first.id, created.key);
  expect(next.turn.message).toBe("总结一下你的研究");
  expect(next.turn.intent).toBeNull();
  expect(next.turn.basedOnReportId).toBe(first.turn.report.id);
  expect(next.history?.[1]?.report).toBe("latest retained");
  expect(next.audit.at(-1)).toMatchObject({
    roundId: next.turn.id,
    kind: "user_message",
  });
});

it("keeps original input separate from clarified goal and approved query", async () => {
  const created = await store.create(
    "original words",
    "Alice",
    true,
    "config-v1",
  );
  await store.decide(
    created.task.id,
    created.key,
    created.task.approval!.id,
    "Alice",
    true,
    "clarified goal",
  );
  const f = fixture();
  let task = await run(f.service(), created.task.id, created.key);
  expect(task.turn).toMatchObject({
    message: "original words",
    intent: "research",
    goal: "clarified goal",
    query: "clarified goal",
  });
  await store.decide(
    task.id,
    created.key,
    task.approval!.id,
    "Alice",
    true,
    "specific query",
  );
  task = await run(f.service(), task.id, created.key);
  expect(task.turn.query).toBe("specific query");
  expect(task.turn.report.quality).toBe("reviewed");
  expect(task.turn.report.revision).toBeGreaterThan(0);
  expect(task.audit.find((e) => e.action === "RETRIEVAL_COMPLETED")?.kind).toBe(
    "rag",
  );
  expect(new Set(task.audit.map((e) => e.id)).size).toBe(task.audit.length);
});

it("retains a partial report with independent quality when execution fails", async () => {
  const f = fixture();
  f.provider.stream = async function* () {
    yield "partial report";
    throw new Error("offline");
  };
  const created = await store.create("question", "Alice", false, "config-v1");
  let task = await run(f.service(), created.task.id, created.key);
  await store.decide(task.id, created.key, task.approval!.id, "Alice", true);
  task = await run(f.service(), task.id, created.key);
  expect(task.status).toBe("failed");
  expect(task.report).toContain("partial report");
  expect(task.report).toContain("未完成文本");
  expect(task.turn.stop?.code).toBe("model_error");
  expect(task.turn.report.quality).toBe("unverified");
});

it("accepts message and legacy question requests, rejects conflicting aliases", async () => {
  const f = fixture();
  const service = f.service();
  vi.spyOn(service, "start").mockResolvedValue(undefined);
  const app = humanRoutes(service);
  const post = (path: string, body: unknown, key = "") =>
    app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-research-key": key },
      body: JSON.stringify(body),
    });
  for (const body of [
    { message: "总结一下你的研究" },
    { question: "old client" },
  ]) {
    const response = await post("/", {
      ...body,
      actor: "Alice",
      clarify: true,
    });
    expect(response.status).toBe(201);
    const { id, key } = await response.json();
    let task = await store.read(id, key);
    expect(task.turn.message).toBe(body.message ?? body.question);
    await store.decide(id, key, task.approval!.id, "Alice", false);
    expect(
      (
        await post(
          `/${id}/followup`,
          { message: "edit this", actor: "Alice" },
          key,
        )
      ).status,
    ).toBe(200);
    task = await store.read(id, key);
    expect(task.turn.message).toBe("edit this");
    expect(task.history?.[0]?.turn.message).toBe(body.message ?? body.question);
  }
  for (const body of [{}, { message: " " }, { message: "a", question: "b" }])
    expect((await post("/", { ...body, actor: "Alice" })).status).toBe(400);
});

it.each([
  ["总结一下你的研究", "summarize"],
  ["缩成三段", "edit"],
  ["改成表格", "edit"],
])(
  "routes %s to the existing report without retrieval or approval",
  async (message, intent) => {
    const f = fixture();
    const created = await store.create(
      "original topic",
      "Alice",
      false,
      "config-v1",
    );
    let task = await run(f.service(), created.task.id, created.key);
    await store.decide(task.id, created.key, task.approval!.id, "Alice", true);
    task = await run(f.service(), task.id, created.key);
    const previousReport = task.report;
    const previousVersion = task.turn.report.revision;
    f.local.retrieve.mockClear();
    f.tools.collect.mockClear();
    const base = f.provider.structuredOutput.bind(f.provider);
    const classify = vi
      .spyOn(f.provider, "structuredOutput")
      .mockImplementation(
        async <T>(
          prompt: string,
          schema: import("zod").z.ZodType<T>,
          signal: AbortSignal,
        ) => {
          if (prompt.includes("Route the project message")) {
            expect(prompt).toContain(
              JSON.stringify(previousReport).slice(1, -1),
            );
            return { intent, goal: message, clarification: "" } as T;
          }
          return base(prompt, schema, signal);
        },
      );
    const transform = vi.spyOn(f.provider, "stream");
    await store.followup(task.id, created.key, message, "Alice");
    task = await run(f.service(), task.id, created.key);
    expect(task.status).toBe("completed");
    expect(task.id).toBe(created.task.id);
    expect(task.approval).toBeNull();
    expect(task.snapshot).toBeNull();
    expect(task.turn).toMatchObject({
      intent,
      message,
      query: null,
      basedOnReportRevision: previousVersion,
    });
    expect(task.turn.routing?.calls).toBe(2);
    expect(task.report).toContain("未重新检索");
    expect(task.turn.report.quality).toBe("unreviewed");
    expect(task.history?.[0]?.report).toBe(previousReport);
    expect(f.local.retrieve).not.toHaveBeenCalled();
    expect(f.tools.collect).not.toHaveBeenCalled();
    expect(classify).toHaveBeenCalledTimes(1);
    expect(transform.mock.calls[0]?.[0]).toContain(
      "Do not research or add new facts",
    );
  },
);

it("asks for clarification after two invalid intent outputs and resumes with the user's answer", async () => {
  const f = fixture();
  const base = f.provider.structuredOutput.bind(f.provider);
  let attempts = 0;
  vi.spyOn(f.provider, "structuredOutput").mockImplementation(
    async <T>(
      prompt: string,
      schema: import("zod").z.ZodType<T>,
      signal: AbortSignal,
    ) => {
      if (prompt.includes("Route the project message") && attempts++ < 2)
        return {} as T;
      return base(prompt, schema, signal);
    },
  );
  const created = await store.create("弄一下", "Alice", false, "config-v1");
  let task = await run(f.service(), created.task.id, created.key);
  expect(task.turn.intent).toBe("clarify");
  expect(task.turn.routing?.calls).toBe(2);
  expect(task.approval?.kind).toBe("clarification");
  expect(f.local.retrieve).not.toHaveBeenCalled();
  await expect(
    store.decide(task.id, created.key, task.approval!.id, "Alice", true),
  ).rejects.toThrow("澄清");
  await store.decide(
    task.id,
    created.key,
    task.approval!.id,
    "Alice",
    true,
    "研究单库方案",
  );
  task = await run(f.service(), task.id, created.key);
  expect(task.turn.message).toBe("弄一下");
  expect(task.turn.goal).toBe("研究单库方案");
  expect(task.approval?.kind).toBe("plan");
  expect(task.snapshot?.calls).toBe(4);
});

it("preserves combined instructions and uses the agent's targeted query", async () => {
  const f = fixture();
  const base = f.provider.structuredOutput.bind(f.provider);
  const message = "总结并补充最新进展";
  const goal = "总结现有单库研究并补查最新进展";
  vi.spyOn(f.provider, "structuredOutput").mockImplementation(
    async <T>(
      prompt: string,
      schema: import("zod").z.ZodType<T>,
      signal: AbortSignal,
    ) => {
      if (prompt.includes("Route the project message"))
        return { intent: "research", goal, clarification: "" } as T;
      if (prompt.includes("Classify the next step")) {
        expect(prompt).toContain(goal);
        return {
          action: "local",
          query: "单库 最新进展",
          questions: [goal],
          reason: "补查",
        } as T;
      }
      return base(prompt, schema, signal);
    },
  );
  const created = await store.create(message, "Alice", false, "config-v1");
  let task = await run(f.service(), created.task.id, created.key);
  expect(task.turn.goal).toBe(goal);
  expect(task.approval?.query).toBe("单库 最新进展");
  await store.decide(task.id, created.key, task.approval!.id, "Alice", true);
  task = await run(f.service(), task.id, created.key);
  expect(task.status).toBe("completed");
  expect(f.local.retrieve).toHaveBeenLastCalledWith(
    "单库 最新进展",
    expect.any(AbortSignal),
  );
});

it("asks for material instead of researching when a summary has no existing report", async () => {
  const f = fixture();
  vi.spyOn(f.provider, "structuredOutput").mockImplementation(
    async <T>() =>
      ({ intent: "summarize", goal: "总结已有研究", clarification: "" }) as T,
  );
  const created = await store.create("总结一下", "Alice", false, "config-v1");
  const task = await run(f.service(), created.task.id, created.key);
  expect(task.status).toBe("pending");
  expect(task.approval?.reason).toContain("没有报告");
  expect(task.turn.intent).toBe("clarify");
  expect(f.calls.plan).toBe(0);
  expect(f.local.retrieve).not.toHaveBeenCalled();
});

it("does not replay an interrupted intent call", async () => {
  const f = fixture();
  const created = await store.create("topic", "Alice", false, "config-v1");
  await store.change(created.task.id, created.key, (task) => {
    task.status = "running";
    task.leaseUntil = new Date(0).toISOString();
    task.turn.routing = {
      phase: "inflight",
      calls: 0,
      units: 0,
      retries: 0,
      elapsedMs: 0,
    };
    return { actor: "system", action: "intent_started", detail: {} };
  });
  const task = await run(f.service(), created.task.id, created.key);
  expect(task.status).toBe("interrupted");
  expect(f.calls.intent).toBe(0);
});

it("retains uncertainty and source lineage across repeated report edits", async () => {
  const f = fixture();
  const created = await store.create("original", "Alice", false, "config-v1");
  let task = await run(f.service(), created.task.id, created.key);
  await store.decide(task.id, created.key, task.approval!.id, "Alice", true);
  task = await run(f.service(), task.id, created.key);
  await store.change(task.id, created.key, (row) => {
    row.turn.report.quality = "unverified";
    row.snapshot!.state.issues = ["缺少性能实测"];
    return { actor: "system", action: "test_warning", detail: {} };
  });
  vi.spyOn(f.provider, "structuredOutput").mockImplementation(
    async <T>() =>
      ({ intent: "edit", goal: "修改格式", clarification: "" }) as T,
  );
  const prompts: string[] = [];
  f.provider.stream = async function* (prompt) {
    prompts.push(prompt);
    yield "调整后 [RAG:1] [RAG:99]";
  };
  for (const message of ["改成表格", "缩成三段"]) {
    await store.followup(task.id, created.key, message, "Alice");
    task = await run(f.service(), task.id, created.key);
    expect(task.status).toBe("completed");
    expect(task.report).toContain("缺少性能实测");
    expect(task.report).toContain("[RAG:1]");
    expect(task.report).not.toContain("[RAG:99]");
    expect(task.turn.report.quality).toBe("unverified");
  }
  expect(prompts[1]).toContain("one data service");
  expect(task.history).toHaveLength(2);
});

it("returns a persisted report without running tools after rejection", async () => {
  const f = fixture();
  const created = await store.create("topic", "Alice", false, "config-v1");
  let task = await run(f.service(), created.task.id, created.key);
  await store.decide(task.id, created.key, task.approval!.id, "Alice", false);
  task = await store.read(task.id, created.key);
  expect(task.status).toBe("rejected");
  expect(task.report).toContain("研究目标");
  expect(task.turn.stop?.code).toBe("cancelled");
  expect(f.local.retrieve).not.toHaveBeenCalled();
  expect((await store.read(task.id, created.key)).report).toBe(task.report);
});
