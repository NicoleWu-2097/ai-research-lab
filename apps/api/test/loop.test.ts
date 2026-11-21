import { expect, it, vi } from "vitest";
import { z } from "zod";
import { runResearchLoop } from "../src/research/loop.js";
import { appendRetrievalNotice } from "../src/research/report.js";
import { ResearchBudget } from "../src/research/budget.js";
import { ModelError, type ModelProvider } from "../src/model/types.js";
import { chunkDocument } from "../src/rag/chunks.js";
import type { ResearchAgents } from "../src/research/review.js";
import { createApp } from "../src/app.js";
const plan = (action = "local", query = "followup") => ({
  action,
  query,
  questions: ["为什么选择单库？"],
  reason: "需要原文支持",
});
const hit = (name: string) => ({
  ...chunkDocument({
    id: `${name}.md`,
    content: `${name} keeps one data service.`,
    sha256: "a".repeat(64),
    retrievedAt: new Date().toISOString(),
  })[0]!,
  score: 0.9,
});
const analysis = (
  id = "RAG:1",
  quote = "one data service",
  unresolved: string[] = [],
) => ({
  findings: [
    {
      kind: "observation",
      text: "文档选择单库。",
      evidence: [{ sourceId: id, quote }],
    },
  ],
  unresolved,
});
const approve = { verdict: "approve" as const, issues: [], summary: "通过" };
const revise = {
  verdict: "revise" as const,
  issues: ["缺少同步成本的证据"],
  summary: "需要更多资料",
};
function fixture(
  steps: unknown[],
  reviews = [approve] as Awaited<ReturnType<ResearchAgents["critique"]>>[],
  hits = [[hit("a")], [hit("b")]],
) {
  const prompts: string[] = [];
  const provider: ModelProvider = {
    provider: "ollama",
    model: "fake",
    async structuredOutput<T>(prompt: string) {
      prompts.push(prompt);
      const next = steps.shift();
      if (next instanceof Error) throw next;
      return next as T;
    },
    async generate() {
      return "你好";
    },
    async *stream() {
      yield "unused";
    },
  };
  const agents: ResearchAgents = {
    research: vi.fn(async () => "待分析草稿 [RAG:1]"),
    critique: vi.fn(async () => reviews.shift()!),
  };
  const local = { retrieve: vi.fn(async () => hits.shift() ?? []) };
  const events: { type: string; [key: string]: unknown }[] = [];
  const deltas: string[] = [];
  const emit = async (type: string, data: Record<string, unknown>) => {
    events.push({ type, ...data });
  };
  return {
    agents,
    provider,
    prompts,
    local,
    events,
    deltas,
    run: (
      budget = new ResearchBudget(),
      signal = new AbortController().signal,
    ) =>
      runResearchLoop(
        "first question",
        provider,
        signal,
        async (text) => {
          deltas.push(text);
        },
        local,
        null,
        emit,
        agents,
        budget,
      ),
  };
}
it("plans, researches, analyzes, critiques and publishes only a quoted final report", async () => {
  const test = fixture([plan(), analysis()]);
  const report = await test.run();
  expect(report).toContain("观察（原文所述）");
  expect(report).toContain("[RAG:1] 原文：“one data service”");
  expect(test.deltas).toEqual([report]);
  expect(test.local.retrieve.mock.calls[0]).toEqual([
    "followup",
    expect.any(AbortSignal),
  ]);
  expect(test.events.at(-1)).toMatchObject({
    type: "LOOP_COMPLETED",
    outcome: "approved",
  });
});
it("turns Critic feedback into new research and preserves citation identity", async () => {
  const test = fixture(
    [
      plan(),
      analysis(),
      plan("local", "synchronization evidence"),
      analysis("RAG:2"),
    ],
    [revise, approve],
  );
  expect(await test.run()).toContain("[RAG:2]");
  expect(test.prompts[2]).toContain("缺少同步成本");
  expect(test.local.retrieve).toHaveBeenCalledTimes(2);
  expect(
    test.events.filter((e) => e.type === "RETRIEVAL_COMPLETED").at(-1)?.sources,
  ).toMatchObject([
    { id: "RAG:1", documentId: "a.md" },
    { id: "RAG:2", documentId: "b.md" },
  ]);
  expect(test.agents.research).toHaveBeenCalledTimes(2);
});
it("stops a repeated retrieval instead of rescuing the same evidence for five rounds", async () => {
  const steps = Array.from({ length: 5 }, (_, i) => [
    plan("local", "query " + i),
    analysis("RAG:1", "one data service", ["缺少性能实测"]),
  ]).flat();
  const test = fixture(
    steps,
    Array(5).fill(approve),
    Array(5).fill([hit("a")]),
  );
  const report = await test.run();
  expect(test.local.retrieve).toHaveBeenCalledTimes(2);
  expect(report).toContain("缺少性能实测");
  expect(test.events).toContainEqual(
    expect.objectContaining({
      type: "RESEARCH_STOPPED",
      message: "本轮没有新增证据，停止补查",
    }),
  );
});
it.each([
  ["RAG:9", "one data service"],
  ["RAG:1", "fabricated quote"],
])("rejects invalid evidence %s %s", async (id, quote) => {
  const test = fixture([plan(), analysis(id, quote)]);
  expect(await test.run()).toContain("待核验");
  expect(test.deltas).toHaveLength(1);
});
it("replans once after an empty retrieval and stops on the next miss", async () => {
  const test = fixture(
    Array.from({ length: 5 }, () => plan()),
    [],
    Array(5).fill([]),
  );
  const report = await test.run();
  expect(report).toContain("目前没有足够资料形成可核实的事实结论。");
  expect(report).toContain("已完成检索：local:followup");
  expect(report).toContain("不能用通用知识补写结论。");
  expect(report).not.toContain("给出分析建议");
  expect(test.local.retrieve).toHaveBeenCalledTimes(2);
  expect(test.events).toContainEqual(
    expect.objectContaining({
      type: "RESEARCH_STOPPED",
      message: "本轮没有新增证据，停止补查",
    }),
  );
});
it("pulls a drifted open question back to the initial goal", async () => {
  const test = fixture(
    [
      plan(),
      analysis("RAG:1", "one data service", ["缺少同步成本的证据"]),
      {
        ...plan("local", "部署教程"),
        serves: "如何部署一个新向量库",
        openQuestions: ["如何部署一个新向量库"],
      },
    ],
    [revise],
    [[hit("a")], [hit("a")]],
  );
  await test.run();
  expect(test.events).toContainEqual(
    expect.objectContaining({
      type: "LOOP_PLAN",
      message: expect.stringContaining("查询已拉回未决问题"),
    }),
  );
  expect(test.prompts[0]).toContain("初始目标（不可自行改写）");
  expect(test.local.retrieve).toHaveBeenCalledTimes(2);
});
it("stops before spending more calls or reservation units than authorized", async () => {
  for (const budget of [new ResearchBudget(1), new ResearchBudget(12, 1)]) {
    const test = fixture([plan(), analysis()]);
    expect(await test.run(budget)).toContain("研究阶段报告");
    expect(test.events).toContainEqual(
      expect.objectContaining({ type: "RESEARCH_STOPPED", code: "budget" }),
    );
    expect(budget.calls).toBeLessThanOrEqual(budget.maxCalls);
    expect(budget.units).toBeLessThanOrEqual(budget.maxUnits);
  }
});
it("permits one transient nonstreaming retry and never retries invalid output", async () => {
  const test = fixture([
    new ModelError("MODEL_PROVIDER_ERROR", "temporary"),
    plan(),
    analysis(),
  ]);
  await test.run();
  expect(test.events.at(-1)).toMatchObject({ retries: 1 });
  const invalid = fixture([new ModelError("MODEL_INVALID_OUTPUT", "bad")]);
  expect(await invalid.run()).toContain("研究阶段报告");
  expect(invalid.events).toContainEqual(
    expect.objectContaining({
      type: "RESEARCH_STOPPED",
      code: "review_format",
    }),
  );
  expect(invalid.prompts).toHaveLength(1);
  const twice = fixture([
    new ModelError("MODEL_PROVIDER_ERROR", "temporary"),
    new ModelError("MODEL_PROVIDER_ERROR", "again"),
  ]);
  expect(await twice.run()).toContain("研究阶段报告");
  expect(twice.events).toContainEqual(
    expect.objectContaining({ type: "RESEARCH_STOPPED", code: "model_error" }),
  );
  expect(twice.prompts).toHaveLength(2);
});
it("replaces an uncited draft with the retrieved excerpt", async () => {
  const test = fixture([plan()]);
  test.agents.research = vi.fn(async () => "提高性能，简化数据管理。");
  const report = await test.run();
  expect(report).toContain("草稿没有有效引用");
  expect(report).toContain("one data service");
  expect(report).not.toContain("提高性能");
  expect(test.events).toContainEqual(
    expect.objectContaining({
      type: "CITATIONS_UNVERIFIED",
      message: "草稿没有有效引用，已改为列出原文片段。",
    }),
  );
});

it("skips retrieval and Critic on a direct greeting", async () => {
  const test = fixture([plan("direct")]);
  expect(await test.run()).toContain("未检索");
  expect(test.local.retrieve).not.toHaveBeenCalled();
  expect(test.agents.research).not.toHaveBeenCalled();
});
it("does not turn tool failures or inconsistent reviews into sufficient evidence", async () => {
  const test = fixture([plan()]);
  test.local.retrieve.mockRejectedValueOnce(new Error("database offline"));
  expect(await test.run()).toContain("研究阶段报告");
  expect(test.deltas).toHaveLength(1);
  expect(test.events).toContainEqual(
    expect.objectContaining({ type: "RESEARCH_STOPPED", code: "tool_error" }),
  );
  const invalid = fixture(
    [plan(), analysis()],
    [{ ...approve, issues: ["conflict"] }],
  );
  expect(await invalid.run()).toContain("待核验报告");
  expect(invalid.events).toContainEqual(
    expect.objectContaining({
      type: "RESEARCH_STOPPED",
      code: "review_format",
    }),
  );
});
it("reads local Markdown when vector retrieval fails", async () => {
  const test = fixture([plan(), analysis()]);
  test.local.retrieve.mockRejectedValueOnce(
    new Error('extension "vector" is not available'),
  );
  const source = {
    id: "0003-storage.md",
    content: "PostgreSQL and pgvector keep one data service.",
    sha256: "a".repeat(64),
    retrievedAt: new Date().toISOString(),
  };
  const tools = { collect: vi.fn(async () => [source]) };
  const report = await runResearchLoop(
    "为什么选择 PostgreSQL 和 pgvector？",
    test.provider,
    new AbortController().signal,
    async (text) => {
      test.deltas.push(text);
    },
    test.local,
    tools,
    async (type, data) => {
      test.events.push({ type, ...data });
    },
    test.agents,
  );
  expect(tools.collect).toHaveBeenCalledOnce();
  expect(report).toContain("[RAG:1] 原文：“one data service”");
  expect(test.events).toContainEqual(
    expect.objectContaining({
      type: "RETRIEVAL_FAILED",
      action: "local",
    }),
  );
  expect(test.events).not.toContainEqual(
    expect.objectContaining({ type: "RESEARCH_STOPPED", code: "tool_error" }),
  );
});
it("cancels stalled remote analysis and times out an HTTP plan", async () => {
  const test = fixture([plan()]);
  const controller = new AbortController();
  test.agents.research = async () => {
    controller.abort(new ModelError("MODEL_CANCELLED", "cancelled"));
    return new Promise(() => {});
  };
  await expect(
    test.run(new ResearchBudget(), controller.signal),
  ).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
  const provider = {
    ...test.provider,
    async structuredOutput<T>(): Promise<T> {
      return new Promise(() => {});
    },
  };
  const response = await createApp(
    provider,
    50,
    null,
    null,
    true,
    true,
    null,
    true,
  ).request("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "why" }),
  });
  const body = await response.text();
  expect(body).toContain('"code":"timeout"');
  expect(body).toContain('"type":"REPORT_DELTA"');
});
it("charges local role calls and schemas through the same budget", async () => {
  const test = fixture([]);
  const budget = new ResearchBudget();
  const wrapped = budget.wrap(test.provider);
  await wrapped.structuredOutput(
    "hello",
    z.object({ value: z.string() }),
    new AbortController().signal,
  );
  await wrapped.generate("hello", new AbortController().signal);
  for await (const text of wrapped.stream(
    "hello",
    new AbortController().signal,
  ))
    expect(text).toBe("unused");
  expect(budget.calls).toBe(3);
  expect(budget.units).toBeGreaterThan(3 * 4096);
});
it("retains up to forty evidence chunks while continuing bounded research", async () => {
  const test = fixture(
    [plan(), analysis()],
    [approve],
    [Array.from({ length: 45 }, (_, i) => hit(String(i)))],
  );
  await test.run();
  expect(
    test.events.find((e) => e.type === "RETRIEVAL_COMPLETED")?.sources,
  ).toHaveLength(40);
});
it("runs actual local role adapters and includes their calls in the shared budget", async () => {
  const test = fixture([plan(), analysis(), approve]);
  test.provider.stream = async function* () {
    yield "文档选择单库 [RAG:1]";
  };
  const budget = new ResearchBudget();
  const report = await runResearchLoop(
    "first",
    test.provider,
    new AbortController().signal,
    async () => {},
    test.local,
    null,
    async () => {},
    null,
    budget,
  );
  expect(report).toContain("原文");
  expect(budget.calls).toBe(4);
});

it("reserves the last model call for synthesis when analysis cannot start", async () => {
  const test = fixture([plan()]);
  const generate = vi
    .spyOn(test.provider, "generate")
    .mockResolvedValue("已取得单库依据 [RAG:1]");
  const budget = new ResearchBudget(2);
  const report = await test.run(budget);
  expect(generate).toHaveBeenCalledTimes(1);
  expect(report).toContain("已取得单库依据");
  expect(report).toContain("待核验");
  expect(budget.calls).toBe(2);
});

it("falls back to retrieved excerpts if the final synthesis also fails", async () => {
  const test = fixture([plan()]);
  vi.spyOn(test.provider, "generate").mockRejectedValue(new Error("offline"));
  const budget = new ResearchBudget(2);
  const report = await test.run(budget);
  expect(report).toContain("原文片段");
  expect(report).toContain("one data service");
  expect(report).not.toContain("offline");
  expect(budget.calls).toBe(2);
});

it("records degradation and appends a retrieval notice when local retrieval degrades", async () => {
  const test = fixture([plan(), analysis()]);
  const events: { type: string; [key: string]: unknown }[] = [];
  const degradedLocal = {
    retrieve: vi.fn(async () => {
      throw new Error("dense retrieval must not run twice");
    }),
    retrieveWithStatus: vi.fn(async () => ({
      hits: [hit("a")],
      degraded: true,
      degradedReason: "嵌入服务调用失败：服务离线",
    })),
  };
  const report = await runResearchLoop(
    "first question",
    test.provider,
    new AbortController().signal,
    async () => {},
    degradedLocal,
    null,
    async (type, data) => {
      events.push({ type, ...data });
    },
    test.agents,
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "RETRIEVAL_DEGRADED",
      strategy: "sparse",
      reason: "嵌入服务调用失败：服务离线",
    }),
  );
  expect(degradedLocal.retrieve).not.toHaveBeenCalled();
  expect(report).toContain("## 检索说明");
  expect(report).toContain("本轮仅使用稀疏检索");
  expect(report).toContain("服务离线");
});

it("keeps reports free of degradation markers on healthy retrieval", async () => {
  const test = fixture([plan(), analysis()]);
  const report = await test.run();
  expect(test.events).not.toContainEqual(
    expect.objectContaining({ type: "RETRIEVAL_DEGRADED" }),
  );
  expect(report).not.toContain("## 检索说明");
});

it("appends the retrieval notice once", () => {
  const once = appendRetrievalNotice("报告正文", "嵌入服务调用失败：服务离线");
  expect(once).toContain("## 检索说明");
  expect(once.match(/## 检索说明/g)).toHaveLength(1);
  expect(appendRetrievalNotice(once, "嵌入服务调用失败：服务离线")).toBe(once);
  expect(appendRetrievalNotice("报告正文", undefined)).toBe("报告正文");
});

it("lists actual web source URLs in the final report", async () => {
  const test = fixture([plan("web"), analysis()]);
  const web = {
    retrieve: vi.fn(async () => [
      { ...hit("a"), url: "https://example.com/research", title: "研究原文" },
    ]),
  };
  const report = await runResearchLoop(
    "联网研究",
    test.provider,
    new AbortController().signal,
    async () => {},
    null,
    null,
    async () => {},
    test.agents,
    new ResearchBudget(),
    undefined,
    web,
  );
  expect(report).toContain("## 联网检索出处");
  expect(report).toContain("[RAG:1] 研究原文 — <https://example.com/research>");
});

it("searches the web when the user asked for it and the plan is invalid", async () => {
  const test = fixture([
    new ModelError("MODEL_INVALID_OUTPUT", "bad plan"),
    analysis(),
  ]);
  const web = {
    retrieve: vi.fn(async () => [
      { ...hit("nobel"), url: "https://example.com/nobel", title: "物理学奖" },
    ]),
  };
  const report = await runResearchLoop(
    "请联网搜索：2024 年诺贝尔物理学奖发给了谁",
    test.provider,
    new AbortController().signal,
    async () => {},
    null,
    null,
    async () => {},
    test.agents,
    new ResearchBudget(),
    undefined,
    web,
  );
  expect(web.retrieve).toHaveBeenCalledWith(
    "2024 年诺贝尔物理学奖发给了谁",
    expect.any(AbortSignal),
  );
  expect(report).toContain("https://example.com/nobel");
});

it("stops a repeated web search when no new page is added", async () => {
  const test = fixture(
    Array.from({ length: 5 }, (_, i) => [
      plan("web", `evidence ${i}`),
      analysis("RAG:1", "one data service", ["缺少性能数据"]),
    ]).flat(),
    Array(5).fill(revise),
  );
  const web = {
    retrieve: vi.fn(async () => [
      { ...hit("a"), url: "https://example.com/source" },
    ]),
  };
  const budget = new ResearchBudget();
  const report = await runResearchLoop(
    "联网研究",
    test.provider,
    new AbortController().signal,
    async () => {},
    null,
    null,
    async () => {},
    test.agents,
    budget,
    undefined,
    web,
  );
  expect(web.retrieve).toHaveBeenCalledTimes(2);
  expect(report).toContain("https://example.com/source");
  expect(budget.calls).toBeLessThanOrEqual(28);
});
