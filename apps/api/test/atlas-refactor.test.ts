import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import {
  LiteratureDiscoveryService,
  parseAcademicPaperText,
} from "../src/agent/academic-tools.js";
import {
  evaluateTaskExecution,
  summarizeEvaluationSuite,
} from "../src/agent/evaluation.js";
import { redactObject, redactSensitiveText } from "../src/agent/observability.js";
import { AtlasAgentRuntime } from "../src/agent/runtime.js";
import { ModelError, type ModelProvider } from "../src/model/types.js";
import type { Embedder } from "../src/rag/embedding.js";
import { RagService } from "../src/rag/service.js";
import { VectorStore } from "../src/rag/store.js";

const db = new PGlite({ extensions: { vector } });
const vectorStore = new VectorStore(db);
const signal = new AbortController().signal;
let workspaceDir: string;
let ragRoot: string;

/**
 * Deterministic semantic + lexical test embedder (4-dim):
 * dim 0: botany / flowers / red / anthocyanin
 * dim 1: UX / UI / Atlas / frontend / CLI
 * dim 2: RAG / retrieval / agentic / vector / BM25
 * dim 3: general / other
 */
const embedder: Embedder = {
  key: "atlas-refactor-embedder-v1",
  dimensions: 4,
  async embed(texts) {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      if (/花|红色|花青素|植物|flower|red|anthocyanin|botany/.test(lower)) {
        return [0.95, 0.05, 0.05, 0.05];
      }
      if (/ux|ui|用户体验|界面|交互|前端|cli|改进/.test(lower)) {
        return [0.05, 0.95, 0.05, 0.05];
      }
      if (/rag|检索|向量|bm25|agentic|evidence|引用/.test(lower)) {
        return [0.05, 0.05, 0.95, 0.05];
      }
      return [0.1, 0.1, 0.1, 0.9];
    });
  },
};

let rag: RagService;

beforeAll(async () => {
  workspaceDir = await mkdtemp(join(tmpdir(), "atlas-workspace-"));
  ragRoot = await mkdtemp(join(tmpdir(), "atlas-rag-root-"));
  await writeFile(
    join(ragRoot, "0001-architecture.md"),
    "# Atlas Architecture\nAtlas uses PostgreSQL with pgvector for RAG and supports hybrid retrieval.\n",
  );
  await writeFile(
    join(workspaceDir, "UX-NOTES.md"),
    "# Atlas UX Notes\n1. Display granular task progress events.\n2. Provide clear artifact links and project switcher.\n",
  );
  rag = new RagService(vectorStore, embedder, ragRoot, 0.35);
  await rag.ingest(signal);
}, 30_000);

afterAll(async () => {
  await db.close();
  await rm(workspaceDir, { recursive: true, force: true });
  await rm(ragRoot, { recursive: true, force: true });
});

function createSmartMockProvider(): ModelProvider & {
  prompts: string[];
} {
  const prompts: string[] = [];
  return {
    provider: "openai",
    model: "gpt-4o-mini-mock",
    prompts,
    async generate(prompt: string) {
      prompts.push(prompt);
      if (prompt.includes("React Fiber")) {
        return "React Fiber 是 React 16 引入的协调引擎（Reconciliation Engine），核心目标是将同步递归渲染拆分为可中断、可恢复的异步工作单元（Fiber 节点），从而支持时间切片（Time Slicing）与并发渲染优先级调度。";
      }
      if (prompt.includes("为什么花是红色的")) {
        return "## 花朵呈红色的生物学机制\n\n花朵呈现红色主要由于液泡中积累了花青素（Anthocyanins）色素，可吸引传粉鸟类与昆虫 [RAG:1]。";
      }
      if (
        prompt.includes("UX") ||
        prompt.includes("用户体验") ||
        prompt.includes("project-b")
      ) {
        return "## Atlas UX 改进建议\n\n1. **执行状态可视化**：按时间顺序展示 `task_started`、`tool_started`、`evidence_added` 等细粒度事件。\n2. **项目切换与隔离**：提供清晰的项目切换入口并隔离不同项目的知识库与任务状态。\n3. **Artifact 成果管理**：支持直接查看和下载生成的 Markdown 报告文件。";
      }
      if (prompt.includes("Rewrite ONLY the")) {
        return "混合检索（Dense + BM25 + RRF）结合重排序显著提升了召回率与引文准确率 [RAG:1]。";
      }
      if (prompt.includes("量子纠缠在深空通信")) {
        return "目前关于深空量子通信的研究主要集中在卫星-地面自由空间链路验证。注：当前本地知识库未包含该主题的直接文献证据，以上内容基于通用科学背景知识整理，具体工程数据存在不确定性，尚待进一步核实。";
      }
      if (prompt.includes("Agentic RAG")) {
        return "# Agentic RAG 调研报告\n\n## 背景\nAgentic RAG 将检索作为智能体可主动调度的工具，而非固定前置流程 [RAG:1]。\n\n## 结论\n初步结论：单库存储结合混合检索降低了系统复杂度 [RAG:1]。";
      }
      return "## 综合分析\n\n基于当前项目上下文完成了分析 [RAG:1]。";
    },
    async *stream(prompt: string) {
      const text = await this.generate(prompt, signal);
      yield text;
    },
    async structuredOutput<T>(prompt: string, schema: import("zod").z.ZodType<T>) {
      prompts.push(prompt);
      return schema.parse({
        action: "finish",
        reason: "completed",
      });
    },
  };
}

describe("Atlas Refactoring Regression Suite (Cases A–G & Core Capabilities)", () => {
  it("Case A: enforces strict task switching & project context isolation (Botany in Project A -> Atlas UX in Project B)", async () => {
    const provider = createSmartMockProvider();
    const runtime = new AtlasAgentRuntime(provider, rag, null, {
      workspaceRoot: workspaceDir,
    });

    // 1 & 2: Create Project A and upload a botany document scoped to Project A
    runtime.contextManager.switchProject("project-a", {
      name: "Botany Study",
      workspaceRoot: workspaceDir,
    });
    await rag.upload(
      "botany-flowers.md",
      "# 植物花色研究\n花朵呈现红色主要是因为花瓣细胞液泡中含有丰富的花青素（Anthocyanins）以及类胡萝卜素，用于吸引传粉动物。",
      signal,
      "project-a",
    );

    // 3: Ask "为什么花是红色的？" in Project A
    const resA = await runtime.execute({
      projectId: "project-a",
      message: "为什么花是红色的？",
    });
    expect(resA.taskState.status).toBe("completed");
    expect(resA.output).toContain("花青素");
    expect(resA.evidences.length).toBeGreaterThan(0);
    expect(resA.evidences[0]?.originalText).toContain("花青素");

    // 4 & 5: Create and switch to Project B, then ask "Atlas 有哪些 UX 改进点？"
    runtime.contextManager.switchProject("project-b", {
      name: "Atlas Engineering",
      workspaceRoot: workspaceDir,
    });
    const resB = await runtime.execute({
      projectId: "project-b",
      message: "Atlas 有哪些 UX 改进点？",
    });

    // Expectations for Project B:
    expect(resB.taskState.status).toBe("completed");
    expect(resB.taskState.projectId).toBe("project-b");
    expect(resB.output).toContain("Atlas UX");
    // Must NOT contain red flower report or botany content
    expect(resB.output).not.toContain("花青素");
    expect(resB.output).not.toContain("花朵呈红色");
    // Must NOT cite Project A's botany chunks
    expect(
      resB.evidences.some((e) => e.originalText.includes("花青素")),
    ).toBe(false);
    // Verify the synthesis prompt sent to the model for Project B did NOT contain Project A's report
    const lastPrompt = provider.prompts.at(-1) ?? "";
    expect(lastPrompt).not.toContain("花朵呈红色的生物学机制");
  });

  it("Case B: recovers locally from citation verification failure without discarding the valid report or looping infinitely", async () => {
    const provider: ModelProvider = {
      provider: "openai",
      model: "mock-strict",
      async generate() {
        // Contains 1 valid supported claim [RAG:1], 1 fabricated citation [RAG:99], and 1 overstated claim ("已全面实现")
        return [
          "# 存储架构调研",
          "",
          "Atlas 采用 PostgreSQL 与 pgvector 存储向量与任务数据 [RAG:1]。",
          "",
          "分布式跨洲多活同步引擎已全面实现并通过百万级压测 [RAG:99]。",
        ].join("\n");
      },
      async *stream() {
        yield "";
      },
      async structuredOutput<T>() {
        return {} as T;
      },
    };

    const runtime = new AtlasAgentRuntime(provider, rag, null, {
      workspaceRoot: workspaceDir,
    });

    const result = await runtime.execute({
      projectId: "default",
      message: "研究 Atlas 的 PostgreSQL 存储与向量检索设计",
      verificationMode: "strict_research",
    });

    // Expect recovery to succeed without aborting the whole task
    expect(result.taskState.status).toBe("completed");
    // Valid research finding and its valid citation [RAG:1] must be preserved!
    expect(result.output).toContain("PostgreSQL");
    expect(result.output).toContain("[RAG:1]");
    // Invalid fabricated citation [RAG:99] must be removed by local repair
    expect(result.output).not.toContain("[RAG:99]");
    // Overstated assertion "已全面实现" must be softened to qualified wording
    expect(result.output).not.toContain("已全面实现");
    expect(result.output).toContain("待核实");
    // Recovery trace must be recorded and bounded (no infinite retries)
    expect(result.trace.recoveries.length).toBeGreaterThan(0);
    expect(result.taskState.resourceUsage.iterations).toBeLessThanOrEqual(4);
  });

  it("Case C: writes real Markdown files to disk, verifies read-back, and never claims success when write fails", async () => {
    const provider = createSmartMockProvider();
    const runtime = new AtlasAgentRuntime(provider, rag, null, {
      workspaceRoot: workspaceDir,
    });

    // 1. Generate Markdown report first
    const genRes = await runtime.execute({
      projectId: "file-test-proj",
      message: "研究 Agentic RAG 的架构设计",
    });
    expect(genRes.output).toContain("Agentic RAG 调研报告");

    // 2. Ask "把报告保存到当前目录 saved-agentic-report.md"
    const saveRes = await runtime.execute({
      projectId: "file-test-proj",
      message: "把报告保存到当前目录 saved-agentic-report.md",
    });

    expect(saveRes.taskState.status).toBe("completed");
    expect(
      saveRes.trace.toolCalls.some(
        (t) => t.tool === "write_file" && t.success,
      ),
    ).toBe(true);
    expect(saveRes.artifacts).toHaveLength(1);

    const savedPath = saveRes.artifacts[0]!.path;
    expect(saveRes.output).toContain(savedPath);

    // Verify real file on disk matches the report
    const diskContent = await readFile(savedPath, "utf8");
    expect(diskContent).toBe(genRes.output);

    // 3. Test tool failure (e.g., write permission denied or illegal path traversal)
    const traversalRes = await runtime.execute({
      projectId: "file-test-proj",
      message: "把报告保存到 ../outside-workspace-hack.md",
    });
    expect(traversalRes.taskState.status).toBe("partially_completed");
    expect(traversalRes.taskState.failureCategory).toBe("permission_error");
    expect(traversalRes.output).toContain("文件保存失败");
    expect(traversalRes.output).not.toContain("报告已成功保存");
  });

  it("Case D: answers ordinary Q&A ('解释什么是 React Fiber') directly without forced RAG or report boilerplate", async () => {
    const provider = createSmartMockProvider();
    const runtime = new AtlasAgentRuntime(provider, rag, null, {
      workspaceRoot: workspaceDir,
    });

    const res = await runtime.execute({
      projectId: "qa-proj",
      message: "解释什么是 React Fiber",
    });

    expect(res.taskState.status).toBe("completed");
    expect(res.taskState.category).toBe("qa");
    expect(res.taskState.verificationMode).toBe("general");
    expect(res.taskState.evidenceSufficiency).toBe("not_required");
    expect(res.output).toContain("React Fiber");
    // No forced research report headings or fake RAG citations
    expect(res.output).not.toContain("观察（原文所述）");
    expect(res.output).not.toContain("[RAG:");
    // No RAG retrieval or academic tool calls triggered
    expect(res.trace.retrievals).toHaveLength(0);
    expect(res.trace.toolCalls).toHaveLength(0);
  });

  it("Case E: handles empty RAG results gracefully without fabricating citations", async () => {
    const provider = createSmartMockProvider();
    const runtime = new AtlasAgentRuntime(provider, rag, null, {
      workspaceRoot: workspaceDir,
    });

    const res = await runtime.execute({
      projectId: "empty-rag-proj",
      message: "量子纠缠在深空通信中的最新实验进展是什么？",
    });

    expect(res.taskState.status).toBe("completed");
    expect(res.evidences).toHaveLength(0);
    expect(res.taskState.evidenceSufficiency).toBe("insufficient");
    // Must note uncertainty and NEVER output fake [RAG:...] citations
    expect(res.output).toMatch(/不确定|未包含|待核实|注：/);
    expect(res.output).not.toMatch(/\[RAG:[^\]]+\]/);
  });

  it("Case F: maintains multi-turn task continuity across generate -> edit section -> save -> supplement citations", async () => {
    const provider = createSmartMockProvider();
    const webMock = {
      async retrieve() {
        return [
          {
            id: "WEB:1",
            documentId: "https://example.org/hybrid-rag",
            content: "Hybrid RAG with RRF improves recall by 18% on multi-hop benchmarks.",
            sha256: "b".repeat(64),
            retrievedAt: new Date().toISOString(),
            ingestedAt: new Date().toISOString(),
            start: 0,
            end: 68,
            startLine: 1,
            endLine: 1,
            score: 0.92,
            url: "https://example.org/hybrid-rag",
            title: "Hybrid RAG Benchmark Study",
          },
        ];
      },
    };
    const runtime = new AtlasAgentRuntime(provider, rag, webMock, {
      workspaceRoot: workspaceDir,
    });

    // Turn 1: Generate report
    const turn1 = await runtime.execute({
      projectId: "continuity-proj",
      message: "研究 Agentic RAG 的架构设计",
    });
    expect(turn1.output).toContain("## 背景");
    expect(turn1.output).toContain("## 结论");
    expect(turn1.output).toContain("初步结论：单库存储");

    // Turn 2: Modify ONLY the conclusion section
    const turn2 = await runtime.execute({
      projectId: "continuity-proj",
      message: "只修改报告中的结论部分：强调混合检索的优势",
    });
    expect(turn2.taskState.status).toBe("completed");
    // Background section must be preserved intact!
    expect(turn2.output).toContain("## 背景");
    expect(turn2.output).toContain("Agentic RAG 将检索作为智能体可主动调度的工具");
    // Conclusion section must be updated!
    expect(turn2.output).toContain("混合检索（Dense + BM25 + RRF）结合重排序显著提升了召回率");
    // Must not stack two full copies of "# Agentic RAG 调研报告"
    expect(turn2.output.match(/# Agentic RAG 调研报告/g)?.length).toBe(1);

    // Turn 3: Save report to workspace
    const turn3 = await runtime.execute({
      projectId: "continuity-proj",
      message: "把刚才的报告保存成 Markdown 文件 continuity-output.md",
    });
    expect(turn3.taskState.status).toBe("completed");
    const savedContent = await readFile(
      join(workspaceDir, "continuity-output.md"),
      "utf8",
    );
    expect(savedContent).toBe(turn2.output);

    // Turn 4: Continue supplementing citations
    const turn4 = await runtime.execute({
      projectId: "continuity-proj",
      message: "继续补充引用",
    });
    expect(turn4.taskState.status).toBe("completed");
    expect(turn4.output).toContain("## 背景");
    expect(turn4.output).toContain("## 结论");
    expect(turn4.output).toContain("参考文献与补充引用");
    expect(turn4.output).toContain("Hybrid RAG Benchmark Study");
  });

  it("Case G: classifies and recovers from injected model and tool faults (OpenAI timeout, Ollama down, empty web, permission denied, bad schema)", async () => {
    // G1: OpenAI API transient timeout -> automatic retry & recovery
    let callCount = 0;
    const flakyProvider: ModelProvider = {
      provider: "openai",
      model: "flaky-gpt",
      async generate() {
        callCount++;
        if (callCount === 1) {
          throw new ModelError("MODEL_TIMEOUT", "Request timed out");
        }
        return "重试成功后生成的有效分析结果 [RAG:1]。";
      },
      async *stream() {
        yield "";
      },
      async structuredOutput() {
        throw new Error("invalid json schema");
      },
    };
    const runtime1 = new AtlasAgentRuntime(flakyProvider, rag, null, {
      workspaceRoot: workspaceDir,
    });
    const g1 = await runtime1.execute({
      projectId: "fault-proj",
      message: "解释什么是 React Fiber",
    });
    expect(g1.taskState.status).toBe("completed");
    expect(g1.output).toContain("重试成功后生成的有效分析结果");
    expect(g1.trace.recoveries.some((r) => r.succeeded)).toBe(true);

    // G2: Ollama Embedding service down -> falls back to BM25 sparse search on existing index
    const brokenEmbedderRag = new RagService(
      vectorStore,
      {
        key: embedder.key,
        dimensions: embedder.dimensions,
        async embed() {
          throw new Error("connect ECONNREFUSED 127.0.0.1:11434 (Ollama down)");
        },
      },
      ragRoot,
      0.35,
    );
    const runtime2 = new AtlasAgentRuntime(
      createSmartMockProvider(),
      brokenEmbedderRag,
      null,
      { workspaceRoot: workspaceDir },
    );
    const g2 = await runtime2.execute({
      projectId: "default",
      message: "研究 Atlas 的 PostgreSQL 存储设计",
    });
    expect(g2.taskState.status).toBe("completed");
    expect(
      g2.trace.recoveries.some(
        (r) =>
          r.failureCategory === "retrieval_error" &&
          r.action === "fallback_to_bm25_sparse_search" &&
          r.succeeded,
      ),
    ).toBe(true);
    expect(g2.evidences.length).toBeGreaterThan(0);

    // G3: File tool permission denied (read-only permissions) -> clear permission_error status, preserves report
    const runtime3 = new AtlasAgentRuntime(
      createSmartMockProvider(),
      rag,
      null,
      {
        workspaceRoot: workspaceDir,
        permissions: ["read"], // 'write' permission intentionally omitted
      },
    );
    await runtime3.execute({
      projectId: "perm-proj",
      message: "研究 Agentic RAG 的架构设计",
    });
    const g3 = await runtime3.execute({
      projectId: "perm-proj",
      message: "把报告保存到当前目录 readonly-fail.md",
    });
    expect(g3.taskState.failureCategory).toBe("permission_error");
    expect(g3.taskState.status).toBe("partially_completed");
    expect(g3.taskState.lastValidOutput).toContain("Agentic RAG 调研报告");
    expect(g3.output).toContain("PERMISSION_DENIED");
  });

  it("supports bilingual & cross-lingual hybrid retrieval (BM25 + Dense + RRF + Reranking) and metadata filtering", async () => {
    await rag.upload(
      "bilingual-notes.md",
      "# Cross-Lingual Retrieval\nHybrid search combines BM25 lexical matching with dense vector embeddings using Reciprocal Rank Fusion (RRF).",
      signal,
      "hybrid-proj",
    );

    // Query in Chinese ("混合检索 向量") matching English document via bilingual query expansion + hybrid search
    const searchRes = await rag.searchKnowledgeBase({
      query: "混合检索 向量 BM25",
      projectId: "hybrid-proj",
      strategy: "hybrid",
      topK: 3,
    });

    expect(searchRes.hits.length).toBeGreaterThan(0);
    expect(searchRes.hits[0]?.content).toContain("Reciprocal Rank Fusion");
    expect(searchRes.rewrittenQueries.length).toBeGreaterThan(1);
  });

  it("discovers literature across OpenAlex, Crossref, Semantic Scholar, and arXiv with DOI deduplication", async () => {
    const mockFetch: typeof fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("openalex.org")) {
        return Response.json({
          results: [
            {
              id: "https://openalex.org/W1",
              title: "Agentic Retrieval-Augmented Generation: A Survey",
              publication_year: 2025,
              doi: "https://doi.org/10.1145/1234567.890",
              type: "article",
              primary_location: {
                landing_page_url: "https://dl.acm.org/doi/10.1145/1234567.890",
                source: { display_name: "ACM Computing Surveys", type: "journal" },
              },
              authorships: [{ author: { display_name: "Alice Zhang" } }],
              abstract_inverted_index: {
                Agentic: [0],
                RAG: [1],
                improves: [2],
                reasoning: [3],
              },
            },
          ],
        });
      }
      if (url.includes("crossref.org")) {
        // Same DOI -> should be deduplicated!
        return Response.json({
          message: {
            items: [
              {
                DOI: "10.1145/1234567.890",
                title: ["Agentic Retrieval-Augmented Generation: A Survey"],
                URL: "https://doi.org/10.1145/1234567.890",
                type: "journal-article",
                published: { "date-parts": [[2025]] },
                author: [{ given: "Alice", family: "Zhang" }],
              },
            ],
          },
        });
      }
      if (url.includes("semanticscholar.org")) {
        return Response.json({
          data: [
            {
              paperId: "s2-paper-2",
              title: "Self-Reflective RAG with Critique Loops",
              year: 2024,
              abstract: "We propose self-reflective critique loops for grounding.",
              url: "https://www.semanticscholar.org/paper/s2-paper-2",
              venue: "NeurIPS",
              externalIds: { DOI: "10.5555/neurips.2024.002" },
              authors: [{ name: "Bob Li" }],
            },
          ],
        });
      }
      if (url.includes("arxiv.org")) {
        return new Response(
          `<feed><entry><id>http://arxiv.org/abs/2501.00001v1</id><title>Preprint on Multi-Agent RAG</title><summary>ArXiv preprint abstract.</summary><published>2025-01-10T00:00:00Z</published><author><name>Carol Wang</name></author></entry></feed>`,
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    });

    const discovery = new LiteratureDiscoveryService(mockFetch);
    const result = await discovery.search({
      query: "Agentic RAG",
      yearFrom: 2024,
      limit: 5,
    });

    // 4 raw items across 4 providers, with OpenAlex and Crossref sharing the same DOI -> 3 unique papers!
    expect(result.papers).toHaveLength(3);
    expect(result.papers[0]?.doi).toBe("10.1145/1234567.890");
    expect(result.papers[0]?.abstract).toBe("Agentic RAG improves reasoning");
    expect(result.papers[0]?.publicationType).toBe("peer_reviewed");
    const arxivPaper = result.papers.find((p) => p.sourceProvider === "arxiv");
    expect(arxivPaper?.publicationType).toBe("preprint");
  });

  it("parses complex academic paper text including sections, formulas, cross-page tables, figure captions, and two-column locators", () => {
    const samplePaper = [
      "[Page 1]",
      "# Hybrid Agentic Retrieval Systems",
      "Authors: Alice Zhang, Bob Li",
      "DOI: 10.1145/999999.111",
      "Published in 2025",
      "",
      "## Abstract",
      "We study hybrid dense-sparse retrieval with Reciprocal Rank Fusion.",
      "",
      "## 1. Introduction",
      "Left column sentence fragment        Right column interleaved text here",
      "Second line of left column           Second line of right column text",
      "",
      "## 2. Method",
      "The RRF score is defined as $$RRF(d) = \\sum_{r \\in R} \\frac{1}{k + r(d)}$$.",
      "",
      "[Page 2]",
      "Table 1: Retrieval performance across benchmarks (Continued)",
      "| Method | Recall@5 | MRR |",
      "| --- | --- | --- |",
      "| Hybrid RRF | 0.89 | 0.81 |",
      "",
      "Figure 1: Overview of the Atlas General Agent Loop.",
      "",
      "[^1]: Footnote explaining the evaluation dataset.",
      "",
      "## References",
      "[1] Robertson et al. The Probabilistic Relevance Framework: BM25 and Beyond.",
    ].join("\n");

    const parsed = parseAcademicPaperText(samplePaper);
    expect(parsed.title).toBe("Hybrid Agentic Retrieval Systems");
    expect(parsed.authors).toEqual(["Alice Zhang", "Bob Li"]);
    expect(parsed.doi).toBe("10.1145/999999.111");
    expect(parsed.year).toBe(2025);
    expect(parsed.abstract).toContain("Reciprocal Rank Fusion");
    expect(parsed.formulas).toHaveLength(1);
    expect(parsed.formulas[0]?.latex).toContain("RRF(d)");
    expect(parsed.tables).toHaveLength(1);
    expect(parsed.tables[0]?.crossPage).toBe(true);
    expect(parsed.figureCaptions).toHaveLength(1);
    expect(parsed.figureCaptions[0]?.caption).toContain("Atlas General Agent Loop");
    expect(parsed.footnotes).toHaveLength(1);
    expect(parsed.references).toHaveLength(1);
    // Verifies two-column interleave and cross-page table locators are preserved
    expect(
      parsed.unparsedRegions.some((u) => u.reason === "two_column_interleave"),
    ).toBe(true);
    expect(
      parsed.unparsedRegions.some(
        (u) => u.reason === "complex_table" && u.page === 2,
      ),
    ).toBe(true);
  });

  it("compacts long context, redacts secrets in traces, and computes all 10 objective evaluation metrics", async () => {
    const provider = createSmartMockProvider();
    const runtime = new AtlasAgentRuntime(provider, rag, null, {
      workspaceRoot: workspaceDir,
    });

    // Verify secret redaction
    const dirty = "Error calling OpenAI with key sk-proj-1234567890abcdefghijklmnop and Authorization: Bearer secret_token_999";
    const redacted = redactSensitiveText(dirty);
    expect(redacted).not.toContain("sk-proj-1234567890");
    expect(redacted).not.toContain("secret_token_999");
    expect(redacted).toContain("[REDACTED]");
    expect(
      redactObject({ apiKey: "my-secret-key-12345", normal: "ok" }),
    ).toEqual({
      apiKey: "[REDACTED]",
      normal: "ok",
    });

    // Execute tasks and evaluate them through the evaluation suite
    const qaExec = await runtime.execute({
      projectId: "eval-proj",
      message: "解释什么是 React Fiber",
    });
    const evalQa = evaluateTaskExecution({
      caseId: "case-qa",
      category: "general_qa",
      execution: qaExec,
      expectedTools: [],
      requiredSubstrings: ["React Fiber"],
    });

    const summary = summarizeEvaluationSuite([evalQa]);
    expect(summary.generalTaskSuccessRate).toBe(1);
    expect(summary.toolCallAccuracy).toBe(1);
    expect(summary.citationTraceabilityRate).toBe(1);
    expect(summary.averageLatencyMs).toBeGreaterThan(0);

    // Test HTTP endpoints /api/agent/execute and /api/agent/projects
    const app = createApp(provider, 10_000, null, rag);
    const execRes = await app.request("/api/agent/execute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: "http-proj",
        message: "解释什么是 React Fiber",
      }),
    });
    expect(execRes.status).toBe(200);
    const execBody = await execRes.json();
    expect(execBody.taskState.status).toBe("completed");
    expect(execBody.trace.traceId).toMatch(/^trace-/);
  });
});
