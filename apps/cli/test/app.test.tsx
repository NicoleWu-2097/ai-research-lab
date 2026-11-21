import { expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vitest 里 ink 的 yoga-layout 会通过 fetch 去取 wasm 二进制。测试如果无条件
// 替换全局 fetch 返回 API JSON，wasm 就被换成一坨 JSON，ink 渲染直接 Abort
// （CompileError: expected magic word 00 61 73 6d）。所以只拦截 /api/ 请求，
// 其余请求（wasm、data: URI 等）交回真实 fetch。
const realFetch = globalThis.fetch.bind(globalThis);
function passThrough(input: unknown, options?: RequestInit) {
  return realFetch(input as RequestInfo, options);
}
function isApi(url: string) {
  return url.includes("/api/");
}

it("keeps approval at the prompt, shows call summaries, and follows up in the same project", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-cli-"));
  vi.stubEnv("RESEARCH_HOME", directory);
  const id = "11111111-1111-4111-8111-111111111111";
  let state = {
    id,
    status: "pending",
    question: "initial",
    report: "",
    error: "",
    approval: {
      id: "approval",
      query: "query",
      reason: "需要证据",
      kind: "plan",
    },
    audit: [{ seq: 1, action: "SECRET_TOOL_DETAIL" }],
  };
  const fetcher = vi.fn(async (input: unknown, _options?: RequestInit) => {
    const url = String(input);
    if (!isApi(url)) return passThrough(input, _options);
    if (url.endsWith("/api/research/tasks"))
      return Response.json({ id, key: "test-only" });
    if (url.endsWith("/approve")) {
      state = { ...state, status: "completed", report: "最终报告正文" };
      return Response.json({ ok: true });
    }
    if (url.endsWith("/followup")) return Response.json({ ok: true });
    return Response.json(state);
  });
  vi.stubGlobal("fetch", fetcher);
  const { App } = await import("../src/app.js");
  const ui = render(<App />);
  async function enter(text: string) {
    ui.stdin.write(text);
    await new Promise((resolve) => setTimeout(resolve, 50));
    ui.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    await enter("initial");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("审批："), {
      timeout: 2500,
    });
    // 每次调用默认可见，只有长输出才折叠。
    expect(ui.lastFrame()).toContain("SECRET_TOOL_DETAIL");
    expect(ui.lastFrame()!.indexOf("等待审批：")).toBeGreaterThan(
      ui.lastFrame()!.indexOf("SECRET_TOOL_DETAIL"),
    );
    await enter("/approve");
    await vi.waitFor(
      () => expect(ui.frames.join("\n")).toContain("最终报告正文"),
      { timeout: 2500 },
    );
    await enter("make it shorter");
    expect(
      fetcher.mock.calls.some(
        ([url, options]) =>
          String(url).endsWith("/" + id + "/followup") &&
          JSON.parse(String(options?.body)).message === "make it shorter",
      ),
    ).toBe(true);
    expect(
      JSON.parse(await readFile(join(directory, id + ".json"), "utf8")).id,
    ).toBe(id);
  } finally {
    ui.unmount();
    ui.cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("navigates project list and 3-option approval selector with j/h + Enter, and wraps long approval messages without truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-cli-projects-"));
  vi.resetModules();
  vi.stubEnv("RESEARCH_HOME", directory);

  const id1 = "11111111-1111-4111-8111-111111111111";
  const id2 = "22222222-2222-4222-8222-222222222222";
  const longClarification =
    "What specific aspects of Atlas are you referring to for improvement in user experience and workflow orchestration?";

  await writeFile(
    join(directory, id1 + ".json"),
    JSON.stringify({
      id: id1,
      key: "key-1",
      title: "为什么花是红色的",
    }),
  );
  await writeFile(
    join(directory, "project.json"),
    JSON.stringify({ id: id1, key: "key-1" }),
  );

  let task1State = {
    id: id1,
    title: "为什么花是红色的",
    status: "pending",
    question: longClarification,
    report: "",
    error: "",
    approval: {
      id: "approval-long",
      query: "flower pigment query",
      question: longClarification,
      reason: longClarification,
      kind: "plan",
    },
    audit: [],
  };

  const fetcher = vi.fn(async (input: unknown, options?: RequestInit) => {
    const url = String(input);
    if (!isApi(url)) return passThrough(input, options);
    if (options?.method === "DELETE") {
      return Response.json({ deleted: true });
    }
    if (url.endsWith("/api/research/tasks")) {
      return Response.json({
        id: id2,
        key: "key-2",
        title: "Atlas UX 改进点",
      });
    }
    if (url.endsWith("/reject")) {
      task1State = {
        ...task1State,
        status: "rejected",
        approval: null as never,
      };
      return Response.json({ ok: true });
    }
    if (url.includes(id1)) {
      return Response.json(task1State);
    }
    return Response.json({
      id: id2,
      title: "Atlas UX 改进点",
      status: "completed",
      question: "Atlas 有哪些 UX 改进点？",
      report: "UX 报告",
      error: "",
      approval: null,
      audit: [],
    });
  });
  vi.stubGlobal("fetch", fetcher);

  const { App } = await import("../src/app.js");
  const ui = render(<App />);

  async function enter(text: string) {
    if (text) {
      ui.stdin.write(text);
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    ui.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 70));
  }

  async function pressKey(ch: string) {
    ui.stdin.write(ch);
    await new Promise((resolve) => setTimeout(resolve, 40));
  }

  try {
    // 1. Startup shows interactive project list with summarized title and j/h options
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain("❯ 1. 为什么花是红色的");
        expect(ui.lastFrame()).toContain("2. + 新建项目");
        expect(ui.lastFrame()).toContain("3. - 删除项目…");
      },
      { timeout: 2500 },
    );

    // 2. Press 'j' then 'h' in project list, then press Enter to open project 1
    await pressKey("j");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("❯ 2. + 新建项目"));
    await pressKey("h");
    await vi.waitFor(() =>
      expect(ui.lastFrame()).toContain("❯ 1. 为什么花是红色的"),
    );
    await enter(""); // Press Enter to confirm opening project 1

    // 3. Project 1 is pending approval: verify full wrapped approval reason (not truncated!) and 3 options
    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? "";
      expect(frame).toContain("workflow orchestration?");
      expect(frame).toContain("❯ 1. 批准并继续");
      expect(frame).toContain("2. 修改查询内容后批准");
      expect(frame).toContain("3. 拒绝并结束");
    });

    // 4. Use 'j' twice to move from option 1 -> option 2 -> option 3 ("3. 拒绝并结束") and press Enter
    await pressKey("j");
    await vi.waitFor(() =>
      expect(ui.lastFrame()).toContain("❯ 2. 修改查询内容后批准"),
    );
    await pressKey("j");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("❯ 3. 拒绝并结束"));
    await enter(""); // Confirm option 3 (reject)

    await vi.waitFor(() => {
      expect(
        fetcher.mock.calls.some(([url]) => String(url).endsWith("/reject")),
      ).toBe(true);
    });

    // 5. Test /help and /delete
    await enter("/help");
    await vi.waitFor(() => {
      expect(ui.frames.join("\n")).toContain("命令帮助 (/help)：");
    });
    await enter("/delete 1");
    await vi.waitFor(() => {
      expect(ui.lastFrame()).toContain("Research workspace");
      expect(ui.lastFrame()).not.toContain(longClarification);
    });
  } finally {
    ui.unmount();
    ui.cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("scrolls long reports inside the isolated viewport via mouse wheel without truncating top paragraphs or moving the bottom input box", async () => {
  const directory = await mkdtemp(join(tmpdir(), "research-cli-scroll-"));
  vi.resetModules();
  vi.stubEnv("RESEARCH_HOME", directory);

  const id = "33333333-3333-4333-8333-333333333333";
  const longLines = Array.from(
    { length: 30 },
    (_, i) => `第 ${i + 1} 段分析内容：Atlas 智能体架构改进细节行 ${i + 1}`,
  ).join("\n");
  const fullReport = `# 第一章：报告开头首段标题\n${longLines}\n## 结尾总结段落`;

  await writeFile(
    join(directory, id + ".json"),
    JSON.stringify({ id, key: "key-scroll", title: "长篇报告滚动测试" }),
  );

  const fetcher = vi.fn(async (input: unknown, options?: RequestInit) => {
    if (!isApi(String(input))) return passThrough(input, options);
    return Response.json({
      id,
      title: "长篇报告滚动测试",
      status: "completed",
      question: "测试长报告滚动",
      report: fullReport,
      error: "",
      approval: null,
      audit: [{ seq: 1, action: "LOOP_COMPLETED" }],
    });
  });
  vi.stubGlobal("fetch", fetcher);

  const { App } = await import("../src/app.js");
  const ui = render(<App />);

  try {
    // Open the project by pressing Enter on the first item
    await vi.waitFor(() =>
      expect(ui.lastFrame()).toContain("1. 长篇报告滚动测试"),
    );
    ui.stdin.write("\r");

    // Wait for the streaming report to finish reaching the bottom ("结尾总结段落")
    await vi.waitFor(
      () => {
        expect(ui.lastFrame()).toContain("结尾总结段落");
      },
      { timeout: 3000 },
    );

    // Send SGR mouse wheel up events (\x1b[<64;10;10M) to scroll up to the very top of the report
    for (let i = 0; i < 15; i++) {
      ui.stdin.write("\x1b[<64;10;10M");
      await new Promise((r) => setTimeout(r, 20));
    }

    await vi.waitFor(() => {
      const frame = ui.lastFrame() ?? "";
      // Top heading of the report is visible and not truncated!
      expect(frame).toContain("# 第一章：报告开头首段标题");
      // Scroll indicator shows we are in scroll-back mode
      expect(frame).toContain("回看中");
      // Visual scrollbar is rendered
      expect(frame).toContain("┃");
      // Bottom input box is still fixed at the bottom and mouse escape codes did not leak into input
      expect(frame).toContain("长篇报告滚动测试 · completed");
      expect(frame).not.toContain("[<64");
    });
  } finally {
    ui.unmount();
    ui.cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

it("clears the home screen, completes commands with Tab and reopens without starting work", async () => {
  vi.resetModules();
  const directory = await mkdtemp(join(tmpdir(), "research-cli-reopen-"));
  vi.stubEnv("RESEARCH_HOME", directory);
  const id = "11111111-1111-4111-8111-111111111111";
  await writeFile(
    join(directory, id + ".json"),
    JSON.stringify({ id, key: "test", title: "demo" }),
  );
  const fetcher = vi.fn(async (input: unknown, options?: RequestInit) => {
    if (!isApi(String(input))) return passThrough(input, options);
    return Response.json({
      id,
      status: "completed",
      question: "topic",
      report: "REPORT-UNIQUE",
      error: "",
      approval: null,
      audit: [],
    });
  });
  vi.stubGlobal("fetch", fetcher);
  const { App } = await import("../src/app.js");
  const ui = render(<App />);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 80));
  const enter = async (text: string) => {
    ui.stdin.write(text);
    await pause();
    ui.stdin.write("\r");
    await pause();
  };
  try {
    await pause();
    ui.stdin.write("/op");
    await pause();
    expect(ui.lastFrame()).toContain("/open");
    ui.stdin.write("\t");
    await pause();
    await enter(" 1");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("completed"));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("REPORT-UNIQUE"));
    await enter("/back");
    expect(ui.lastFrame()).toContain("Research workspace");
    expect(ui.lastFrame()).not.toContain("REPORT-UNIQUE");
    await enter("/open 1");
    await vi.waitFor(() => expect(ui.lastFrame()).toContain("REPORT-UNIQUE"));
    expect(ui.lastFrame()).not.toContain("正在执行");
    expect(
      fetcher.mock.calls.every((args) => {
        const options = (args as unknown as [unknown, RequestInit?])[1];
        return !options?.method || options.method === "GET";
      }),
    ).toBe(true);
  } finally {
    ui.unmount();
    ui.cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
