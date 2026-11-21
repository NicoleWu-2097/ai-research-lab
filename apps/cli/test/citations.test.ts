import { describe, expect, it } from "vitest";
import {
  buildEvidenceCard,
  buildReportBlock,
  buildSourcesIndex,
  citationNumber,
  locateQuote,
  quoteWindow,
  type FindingLike,
  type SourceLike,
} from "../src/citations.js";

const source: SourceLike = {
  id: "RAG:1",
  documentId: "0003-storage-and-protocol-boundaries.md",
  startLine: 1,
  endLine: 17,
  score: 0.5208822317414219,
  sha256: "db457cef2ff861293139c85be8dedab0474a81a847aec7ef463821a21e709c2c",
  retrievedAt: "2026-11-18T14:27:41.326Z",
  content: [
    "# ADR 0003：单库起步，协议按真实边界引入",
    "",
    "状态：已接受。日期：2026-10-05。",
    "",
    "## 决定",
    "",
    "M5 以 PostgreSQL + [pgvector](https://github.com/pgvector/pgvector) 存来源片段和向量，先做精确余弦检索；任务和事件持久化留到 M9。",
    "PostgreSQL 全文检索作为后续混合检索候选，按召回评估决定是否引入。",
  ].join("\n"),
};

const findings: FindingLike[] = [
  {
    kind: "observation",
    text: "M5 以 PostgreSQL + pgvector 存来源片段和向量，先做精确余弦检索。",
    evidence: [
      {
        sourceId: "RAG:1",
        quote: "M5 以 PostgreSQL + pgvector 存来源片段和向量，先做精确余弦检索",
      },
    ],
  },
  {
    kind: "inference",
    text: "选型基于单库起步与简化运维的考虑。",
    evidence: [{ sourceId: "RAG:1", quote: "初期只运行一套数据服务" }],
  },
  {
    kind: "observation",
    text: "这条属于别的来源。",
    evidence: [{ sourceId: "RAG:2", quote: "别的原文" }],
  },
];

describe("citationNumber", () => {
  it("优先使用 RAG:n 里的编号", () => {
    expect(citationNumber({ id: "RAG:7" }, 0)).toBe(7);
  });
  it("没有编号时退回数组下标", () => {
    expect(citationNumber({ id: "chunk-abc" }, 2)).toBe(3);
  });
});

describe("buildSourcesIndex", () => {
  it("每份来源一行，带文件、行号与相似度", () => {
    const index = buildSourcesIndex([source]);
    expect(index).toContain("来源（1 份");
    expect(index).toContain(
      "[RAG:1] 0003-storage-and-protocol-boundaries.md · L1–17 · 0.52",
    );
  });
  it("没有来源时返回空串", () => {
    expect(buildSourcesIndex([])).toBe("");
  });
});

describe("locateQuote / quoteWindow", () => {
  it("能定位原文里的引文", () => {
    expect(
      locateQuote(source.content ?? "", "M5 以 PostgreSQL"),
    ).toBeGreaterThan(0);
  });
  it("能穿透 Markdown 链接找到引文", () => {
    const at = locateQuote(
      source.content ?? "",
      "M5 以 PostgreSQL + pgvector 存来源片段和向量，先做精确余弦检索",
    );
    expect(at).toBeGreaterThan(0);
  });
  it("窗口用 «» 标出被引用的片段并补省略号", () => {
    const window = quoteWindow(
      source.content ?? "",
      "M5 以 PostgreSQL + pgvector 存来源片段和向量",
      20,
    );
    expect(window).toContain("«");
    expect(window).toContain("»");
    expect(window.startsWith("…")).toBe(true);
  });
});

describe("buildEvidenceCard", () => {
  it("列出支撑的结论、只保留本来源的引文", () => {
    const card = buildEvidenceCard(source, findings, { index: 0 });
    expect(card).toContain("证据卡 [RAG:1]");
    expect(card).toContain("支撑的结论（2 条）");
    expect(card).toContain("观察 · M5 以 PostgreSQL");
    expect(card).toContain("推断 · 选型基于单库起步");
    expect(card).not.toContain("这条属于别的来源");
  });
  it("截窗时提示还剩多少字并给出 full 用法", () => {
    const long = {
      ...source,
      content: "甲".repeat(1000) + "目标引文" + "乙".repeat(1000),
    };
    const card = buildEvidenceCard(
      long,
      [
        {
          kind: "observation",
          text: "x",
          evidence: [{ sourceId: "RAG:1", quote: "目标引文" }],
        },
      ],
      { index: 0 },
    );
    expect(card).toContain("/cite 1 full");
  });
  it("没有结构化证据时给出兜底说明", () => {
    const card = buildEvidenceCard(source, [], { index: 0 });
    expect(card).toContain("本轮未生成结构化证据");
    expect(card).toContain("ADR 0003");
  });
  it("full 模式输出完整原文", () => {
    const card = buildEvidenceCard(source, findings, { index: 0, full: true });
    expect(card).toContain("按召回评估决定是否引入");
    expect(card).not.toContain("查看全文");
  });
});

describe("buildReportBlock", () => {
  it("报告后面追加来源索引", () => {
    const block = buildReportBlock("## 观察\n内容 [RAG:1]", [source]);
    expect(block).toContain("内容 [RAG:1]");
    expect(block).toContain("来源（1 份");
  });
  it("没有来源时保持报告原样", () => {
    expect(buildReportBlock("只有报告", [])).toBe("只有报告");
  });
});
