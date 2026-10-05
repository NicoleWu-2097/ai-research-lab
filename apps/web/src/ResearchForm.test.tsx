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
    { type: "REPORT_DELTA", text: "Analysis" },
    { type: "AGENT_COMPLETED", report: "Analysis" },
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
  expect(screen.getByText("Analysis")).toBeTruthy();
  expect(screen.getByText("任务 ID：test-task")).toBeTruthy();
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
