// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ResearchForm } from "./ResearchForm";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("submits a question and displays its completed report", async () => {
  const events = [
    { type: "AGENT_STARTED" },
    { type: "AGENT_DECISION", message: "路径选择：MCP 文档工具" },
    { type: "TOOLS_DISCOVERED", message: "MCP 已发现资料工具" },
    { type: "TOOL_RESULT", message: "读取成功：storage.md" },
    {
      type: "RETRIEVAL_COMPLETED",
      sources: [
        {
          id: "RAG:1",
          chunkId: "RAG:stable-hash",
          documentId: "storage.md",
          content: "原始证据片段",
          sha256: "a".repeat(64),
          startLine: 2,
          endLine: 4,
          score: null,
        },
      ],
    },
    { type: "EVIDENCE_ASSESSED", message: "证据评估：证据足够" },
    { type: "RESEARCH_STOPPED", message: "取证结束：证据足够" },
    { type: "A2A_DISCOVERED", message: "A2A 已发现 researcher" },
    { type: "A2A_PROGRESS", message: "A2A researcher：正在处理" },
    { type: "ROLE_DELEGATED", message: "Coordinator：委派研究执行者" },
    { type: "CRITIC_REVIEWED", message: "Critic：需要修订引用" },
    { type: "COORDINATOR_COMPLETED", message: "Coordinator：审查通过" },
    { type: "REPORT_DELTA", text: "Analysis" },
    { type: "LOOP_PLAN", message: "计划：查明存储理由" },
    { type: "AGENT_COMPLETED", report: "Analysis [RAG:1]" },
  ];
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          events
            .map(
              (event, index) =>
                `data: ${JSON.stringify({ taskId: "test-task", sequence: index + 1, ...event })}\n\n`,
            )
            .join(""),
        ),
      ),
  );
  render(<ResearchForm />);
  fireEvent.change(screen.getByLabelText("研究问题"), {
    target: { value: "Compare designs" },
  });
  fireEvent.click(screen.getByText("开始研究"));
  expect(await screen.findByText("研究状态：completed")).toBeTruthy();
  expect(screen.getByText(/Analysis/)).toBeTruthy();
  const reference = screen.getByRole("link", { name: "[RAG:1]" });
  fireEvent.click(reference);
  expect(document.getElementById("source-RAG:1")?.hasAttribute("open")).toBe(
    true,
  );
  expect(screen.getByText("计划：查明存储理由")).toBeTruthy();
  expect(screen.getByText("Coordinator：委派研究执行者")).toBeTruthy();
  expect(screen.getByText("Critic：需要修订引用")).toBeTruthy();
  expect(screen.getByText("Coordinator：审查通过")).toBeTruthy();
  expect(screen.getByText("A2A 已发现 researcher")).toBeTruthy();
  expect(screen.getByText("A2A researcher：正在处理")).toBeTruthy();
  expect(screen.getByText("任务 ID：test-task")).toBeTruthy();
  expect(screen.getByText("读取成功：storage.md")).toBeTruthy();
  expect(screen.getByText("原始证据片段")).toBeTruthy();
  expect(screen.getByText("storage.md：第 2–4 行")).toBeTruthy();
  expect(screen.getByText("路径选择：MCP 文档工具")).toBeTruthy();
  expect(screen.getByText("证据评估：证据足够")).toBeTruthy();
  expect(screen.getByText("取证结束：证据足够")).toBeTruthy();
  expect(screen.getByText(/MCP 文档片段/)).toBeTruthy();
});

it("cancels a pending request", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    ),
  );
  render(<ResearchForm />);
  fireEvent.change(screen.getByLabelText("研究问题"), {
    target: { value: "Compare designs" },
  });
  fireEvent.click(screen.getByText("开始研究"));
  fireEvent.click(await screen.findByText("取消"));
  expect(await screen.findByText("研究状态：cancelled")).toBeTruthy();
});
