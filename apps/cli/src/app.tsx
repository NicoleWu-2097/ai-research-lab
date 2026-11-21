import { saveReport } from "./save-report.js";
import {
  buildEvidenceCard,
  buildReportBlock,
  buildSourcesIndex,
  citationNumber,
  type FindingLike,
  type SourceLike,
} from "./citations.js";
import { commandSuffix } from "./commands.js";
import { renderCallLog } from "./call-log.js";
import type {
  TurnMetadata,
  ContentKind,
} from "../../api/src/human/contract.js";
import wrapAnsi from "wrap-ansi";
import { stripVTControlCharacters } from "node:util";
import { useEffect, useState, useRef } from "react";
import { Box, Text, useApp, useInput, useStdin, useWindowSize } from "ink";
import TextInput from "ink-text-input";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";

const base = process.env.RESEARCH_API_URL ?? "http://127.0.0.1:3001";
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
  throw new Error("CLI requires a local API");
const directory =
  process.env.RESEARCH_HOME ?? join(homedir(), ".ai-research-lab");

export type Credential = {
  id: string;
  key: string;
  title?: string;
  createdAt?: string;
};

type Task = {
  id: string;
  title?: string;
  status: string;
  question: string;
  turn?: TurnMetadata;
  report: string;
  error: string;
  approval: null | {
    id: string;
    query: string;
    question: string;
    questions?: string[];
    reason: string;
    kind: string;
    goal?: string;
    serves?: string;
  };
  snapshot?: {
    next: string;
    calls: number;
    units?: number;
    retries?: number;
    state?: {
      sources?: SourceLike[];
      analysis?: { findings?: FindingLike[]; unresolved?: string[] };
    };
  };
  audit: {
    seq: number | string;
    id?: string;
    roundId?: string;
    kind?: ContentKind;
    action: string;
    created_at?: string;
    detail?: Record<string, unknown> & {
      message?: string;
      query?: string;
      tool?: string;
      node?: string;
    };
  }[];
  history?: {
    question: string;
    report: string;
    turn?: TurnMetadata;
    status?: string;
  }[];
};

type MenuOption = {
  id: string;
  label: string;
  act: () => Promise<void> | void;
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PULSE_DOTS = ["·  ", "·· ", "···", " ··"];
const SGR_MOUSE_GLOBAL_RE = /\[<(\d+);\d+;\d+[Mm]/g;

const NODE_LABELS: Record<string, string> = {
  planning: "思考与规划研究路径",
  research: "执行 RAG 检索与工具调用",
  analyze: "分析证据与生成草稿",
  critique: "审查结论与校验引文",
  publish: "汇总最终报告",
};

function describeActiveStep(task: Task | null): string {
  if (!task) return "准备执行任务";
  const lastEvent = task.audit.at(-1);
  if (lastEvent) {
    if (lastEvent.action === "RETRIEVAL_STARTED") {
      return `正在执行 RAG 检索${task.turn?.query ? `：「${task.turn.query}」` : ""}`;
    }
    if (lastEvent.action === "TOOL_CALLED") {
      return `正在调用工具：${lastEvent.detail?.tool ?? "外部工具"}`;
    }
    if (
      lastEvent.action === "LOOP_PLAN" ||
      lastEvent.action === "intent_started"
    ) {
      return "正在思考与规划下一步行动";
    }
    if (lastEvent.action === "LOOP_ANALYSIS") {
      return "正在整理证据并撰写分析草稿";
    }
    if (lastEvent.action === "ROLE_DELEGATED") {
      return "正在调用 Critic 审查分析草稿";
    }
  }
  if (task.snapshot?.next && NODE_LABELS[task.snapshot.next]) {
    return NODE_LABELS[task.snapshot.next]!;
  }
  return "正在执行研究与推理";
}

export function summarizeTitle(message: string): string {
  const withoutAttachments = message
    .split(/\n请优先检索本地上传资料：/)[0]!
    .trim();
  const firstClause =
    withoutAttachments
      .split(/[\n。？！?!；;]+/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? withoutAttachments;
  const stripped = firstClause
    .replace(
      /^(请问一下|请问|请帮我|帮我|请解释一下|请解释|解释一下|请分析一下|请分析|分析一下|请研究一下|研究一下|调研一下|调查一下|告诉我|我想知道)\s*/i,
      "",
    )
    .replace(/[？?。！!，,、：:]+$/g, "")
    .trim();
  const text = stripped || firstClause || "未命名项目";
  return text.length > 28 ? `${text.slice(0, 28)}…` : text;
}

const HELP_TEXT = [
  "命令帮助 (/help)：",
  "  快捷键          j/h (或 ↑/↓) 移动选项，Enter 确认，+/- 调整框高，鼠标滚轮或 PgUp/PgDn 滚动内容",
  "  直接输入内容    未进入项目时新建项目；在项目中则继续追问或修改报告",
  "  /projects       进入项目列表    /new [问题]      新建项目",
  "  /open <序号|ID> 打开指定项目    /delete [序号]   删除项目",
  "  /back           返回项目列表    /size <行数>     调整输入框高度",
  "  /upload <路径>  上传文档(≤24KB) /report          查看当前报告",
  "  /cite [编号]    来源索引或证据卡（/cite 1 full 看原文全文）",
  "  /save [目录]    保存最新报告为 Markdown（默认启动 CLI 的目录）",
  "  /history        查看历史记录    /tools           展开/收起思考与工具调用详情",
  "  /approval       查看待审批详情  /approve [内容]  批准计划或提交澄清",
  "  /continue [指令] 根据上一轮所需证据继续科研（指令可选）",
  "  /reject         拒绝当前计划    /resume          恢复中断的任务",
  "  /help           显示本帮助信息  /quit            退出 CLI",
].join("\n");

async function request(
  path: string,
  credential: Credential | null,
  body?: unknown,
  method?: "GET" | "POST" | "DELETE",
) {
  const effectiveMethod = method ?? (body ? "POST" : "GET");
  const response = await fetch(base + path, {
    method: effectiveMethod,
    headers: {
      ...(credential ? { "x-research-key": credential.key } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (
    !response.ok &&
    response.status === 404 &&
    path === "/api/research/tasks"
  ) {
    throw new Error(
      "研究任务接口不可用：请在 apps/api/.env 设置 HUMAN_ENABLED=true 并重启 API。",
    );
  }
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(
      `API 返回了非 JSON 响应（HTTP ${response.status}），请检查 API 地址及服务配置。`,
    );
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function formatProjectList(items: Credential[]): string {
  if (items.length === 0) {
    return "项目列表：暂无项目（可用 j/h 选择下方选项按 Enter 确认，或直接输入问题新建项目）";
  }
  return (
    "项目列表（可用 j/h 上下选择并按 Enter 确认，或用 /open <序号>、/delete <序号>）：\n" +
    items
      .map(
        (item, index) =>
          `  ${index + 1}. ${item.title || "未命名项目"} (${item.id})`,
      )
      .join("\n")
  );
}

export function App() {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { rows, columns } = useWindowSize();
  const [input, setInput] = useState("");
  const [inputEpoch, setInputEpoch] = useState(0);
  const [homeHelp, setHomeHelp] = useState(false);
  const [credential, setCredential] = useState<Credential | null>(null);
  const [projects, setProjects] = useState<Credential[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tools, setTools] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [menuMode, setMenuMode] = useState<
    "project_list" | "delete_project" | "text_input"
  >("project_list");
  const [editingApproval, setEditingApproval] = useState(false);
  const [boxMinHeight, setBoxMinHeight] = useState(4);
  const [scrollOffset, setScrollOffset] = useState(0);

  // 动画帧与逐 token 流式打字机状态
  const [animTick, setAnimTick] = useState(0);
  const [typingQueue, setTypingQueue] = useState<string[]>([]);
  const [activeTyping, setActiveTyping] = useState<{
    fullText: string;
    visibleLen: number;
  } | null>(null);
  const [previewVisibleLen, setPreviewVisibleLen] = useState(0);

  const viewGeneration = useRef(0);
  const shownReports = useRef(new Set<string>());
  const maxScrollRef = useRef(0);

  const totalRows = Math.max(12, (rows || 24) - 1);
  const totalCols = Math.max(30, columns || 80);
  const innerWidth = Math.max(20, totalCols - 6);
  const contentWidth = Math.max(20, totalCols - 4);

  const isTaskRunning = Boolean(credential && task?.status === "running");

  function resetProjectView() {
    viewGeneration.current++;
    setCredential(null);
    setTask(null);
    setMessages([]);
    setHomeHelp(false);
    setTypingQueue([]);
    setActiveTyping(null);
    setPreviewVisibleLen(0);
    setScrollOffset(0);
    setEditingApproval(false);
    setTools(false);
    shownReports.current.clear();
  }

  function scrollBy(deltaLines: number) {
    setScrollOffset((prev) => {
      const next = prev + deltaLines;
      return Math.max(0, Math.min(maxScrollRef.current, next));
    });
  }

  function appendMessageImmediate(msg: string) {
    setScrollOffset(0);
    setMessages((items) => [...items, msg]);
  }

  function enqueueStreamingText(msg: string) {
    setScrollOffset(0);
    setTypingQueue((q) => [...q, msg]);
  }

  // 任务执行中动效定时器（状态标签 spinner 与正在调用工具的脉冲动画）
  useEffect(() => {
    if (!isTaskRunning) return;
    const timer = setInterval(() => {
      setAnimTick((t) => t + 1);
    }, 120);
    return () => clearInterval(timer);
  }, [isTaskRunning]);

  // 队列消费：启动下一段待流式输出的文本
  useEffect(() => {
    if (!activeTyping && typingQueue.length > 0) {
      const [next, ...rest] = typingQueue;
      setTypingQueue(rest);
      setActiveTyping({ fullText: next!, visibleLen: 0 });
    }
  }, [activeTyping, typingQueue]);

  // 逐 token（多字符分块）动态输出完成报告，避免整段文本直接生硬贴出
  useEffect(() => {
    if (!activeTyping) return;
    const generation = viewGeneration.current;
    const timer = setInterval(() => {
      setActiveTyping((curr) => {
        if (!curr || generation !== viewGeneration.current) return null;
        const step = Math.max(
          10,
          Math.min(48, Math.ceil(curr.fullText.length / 18)),
        );
        const nextLen = curr.visibleLen + step;
        if (nextLen >= curr.fullText.length) {
          setMessages((items) => [...items, curr.fullText]);
          return null;
        }
        return { ...curr, visibleLen: nextLen };
      });
    }, 24);
    return () => clearInterval(timer);
  }, [activeTyping]);

  // 实时生成中的预览报告也采用平滑逐块追赶显示
  const rawPreviewText =
    task?.report &&
    ![
      "completed",
      "error",
      "failed",
      "interrupted",
      "rejected",
      "expired",
    ].includes(task.status)
      ? task.report
      : "";

  useEffect(() => {
    if (!rawPreviewText) {
      setPreviewVisibleLen(0);
      return;
    }
    if (previewVisibleLen >= rawPreviewText.length) return;
    const timer = setInterval(() => {
      setPreviewVisibleLen((len) => {
        if (len >= rawPreviewText.length) return len;
        const diff = rawPreviewText.length - len;
        const step = Math.max(8, Math.min(40, Math.ceil(diff / 4)));
        return Math.min(rawPreviewText.length, len + step);
      });
    }, 25);
    return () => clearInterval(timer);
  }, [rawPreviewText, previewVisibleLen]);

  async function loadProjects(): Promise<Credential[]> {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(directory))
      .filter((f) => f.endsWith(".json") && f !== "project.json")
      .sort();
    const list: Credential[] = [];
    for (const file of files) {
      try {
        const filePath = join(directory, file);
        const parsed = JSON.parse(
          await readFile(filePath, "utf8"),
        ) as Credential;
        if (!parsed.id || !parsed.key) continue;
        if (!parsed.title) {
          try {
            const remote = (await request(
              `/api/research/tasks/${parsed.id}`,
              parsed,
            )) as Task;
            parsed.title =
              remote.title ||
              summarizeTitle(
                remote.history?.[0]?.question ??
                  remote.question ??
                  "未命名项目",
              );
            await writeFile(filePath, JSON.stringify(parsed), { mode: 0o600 });
          } catch {
            parsed.title = "未命名项目";
          }
        }
        list.push(parsed);
      } catch {
        // ignore malformed file
      }
    }
    setProjects(list);
    return list;
  }

  useEffect(() => {
    void loadProjects()
      .then(() => {
        if (viewGeneration.current !== 0) return;
        setMenuMode("project_list");
        setSelectedIndex(0);
        setScrollOffset(0);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!credential) return;
    const generation = viewGeneration.current;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let nextPollMs = 800;
      try {
        const response = await fetch(
          `${base}/api/research/tasks/${credential.id}`,
          {
            headers: { "x-research-key": credential.key },
            signal: controller.signal,
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = (await response.json()) as Task;
        if (controller.signal.aborted || generation !== viewGeneration.current)
          return;
        const resolvedTitle =
          next.title ||
          credential.title ||
          summarizeTitle(next.question || "未命名项目");
        next.title = resolvedTitle;
        if (["running", "queued", "ready"].includes(next.status)) {
          nextPollMs = 300;
        }
        setTask((prev) => {
          if (
            prev?.approval?.id !== next.approval?.id &&
            next.status === "pending"
          ) {
            setSelectedIndex(0);
            setEditingApproval(false);
          }
          return next;
        });
        setError("");
        const reportKey = `${next.id}:${next.turn?.id ?? next.history?.length ?? 0}:${next.turn?.report.revision ?? next.report}:${next.status}`;
        if (
          next.report &&
          [
            "completed",
            "error",
            "failed",
            "interrupted",
            "rejected",
            "expired",
          ].includes(next.status) &&
          !shownReports.current.has(reportKey)
        ) {
          shownReports.current.add(reportKey);
          enqueueStreamingText(
            `${next.status === "completed" ? "最终报告" : "报告更新"}\n${buildReportBlock(
              next.report,
              next.snapshot?.state?.sources ?? [],
            )}`,
          );
        }
      } catch (e) {
        if (!controller.signal.aborted && generation === viewGeneration.current)
          setError(String(e));
      }
      if (!controller.signal.aborted && generation === viewGeneration.current)
        timer = setTimeout(() => void poll(), nextPollMs);
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [credential]);

  function resolveTargetProject(
    rawTarget: string,
    list: Credential[],
  ): Credential | undefined {
    const trimmed = rawTarget.trim();
    if (!trimmed) return undefined;
    if (/^\d+$/.test(trimmed)) {
      const idx = Number(trimmed) - 1;
      if (idx >= 0 && idx < list.length) return list[idx];
    }
    return (
      list.find((p) => p.id === trimmed) ??
      list.find((p) => p.id.startsWith(trimmed)) ??
      list.find((p) => p.title === trimmed)
    );
  }

  async function openProjectRecord(target: Credential) {
    resetProjectView();
    const generation = viewGeneration.current;
    setBusy(true);
    setError("");
    try {
      const remote = (await request(
        `/api/research/tasks/${target.id}`,
        target,
      )) as Task;
      const title =
        remote.title ||
        target.title ||
        summarizeTitle(remote.question || "未命名项目");
      const updated: Credential = { ...target, title };
      await writeFile(
        join(directory, target.id + ".json"),
        JSON.stringify(updated),
        { mode: 0o600 },
      );
      if (generation !== viewGeneration.current) return;
      setTask({ ...remote, title });
      setCredential(updated);
      setMenuMode("text_input");
      setEditingApproval(false);
      setSelectedIndex(0);
      await loadProjects();
      appendMessageImmediate(`已打开项目：${title} (${target.id})`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteProjectRecord(target: Credential) {
    setBusy(true);
    setError("");
    try {
      await request(
        `/api/research/tasks/${target.id}`,
        target,
        undefined,
        "DELETE",
      ).catch(() => undefined);
      await rm(join(directory, target.id + ".json"), { force: true });
      await rm(join(directory, "project.json"), { force: true });
      if (credential?.id === target.id) {
        resetProjectView();
      }
      const remaining = await loadProjects();
      setMenuMode("project_list");
      setSelectedIndex(0);
      appendMessageImmediate(
        `已删除项目：${target.title || summarizeTitle(target.id)} (${target.id})\n` +
          formatProjectList(remaining),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const isApprovalPending = Boolean(
    credential && task?.approval && task.status === "pending",
  );

  const activeOptions: MenuOption[] = (() => {
    if (isApprovalPending && !editingApproval) {
      return [
        {
          id: "approve",
          label:
            task?.approval?.kind === "clarification"
              ? "1. 填写澄清说明并批准"
              : "1. 批准并继续",
          act: async () => {
            if (task?.approval?.kind === "clarification") {
              setEditingApproval(true);
              setInput("");
              return;
            }
            await submit("/approve");
          },
        },
        {
          id: "edit_approve",
          label:
            task?.approval?.kind === "clarification"
              ? "2. 输入补充背景后继续"
              : "2. 修改查询内容后批准",
          act: () => {
            setEditingApproval(true);
            setInput(task?.approval?.query || "");
          },
        },
        {
          id: "reject",
          label: "3. 拒绝并结束",
          act: async () => {
            await submit("/reject");
          },
        },
      ];
    }

    if (!credential && menuMode === "delete_project") {
      return [
        ...projects.map((p, idx) => ({
          id: `del-${p.id}`,
          label: `${idx + 1}. 删除：${p.title || "未命名项目"} (${p.id.slice(0, 8)})`,
          act: async () => {
            await deleteProjectRecord(p);
          },
        })),
        {
          id: "cancel_delete",
          label: `${projects.length + 1}. ← 返回项目列表`,
          act: () => {
            setMenuMode("project_list");
            setSelectedIndex(0);
          },
        },
      ];
    }

    if (!credential && menuMode === "project_list") {
      const opts: MenuOption[] = projects.map((p, idx) => ({
        id: `open-${p.id}`,
        label: `${idx + 1}. ${p.title || "未命名项目"} (${p.id.slice(0, 8)})`,
        act: async () => {
          await openProjectRecord(p);
        },
      }));
      opts.push({
        id: "new_project",
        label: `${opts.length + 1}. + 新建项目`,
        act: () => {
          setMenuMode("text_input");
          setInput("");
        },
      });
      if (projects.length > 0) {
        opts.push({
          id: "delete_project_menu",
          label: `${opts.length + 1}. - 删除项目…`,
          act: () => {
            setMenuMode("delete_project");
            setSelectedIndex(0);
          },
        });
      }
      opts.push({
        id: "help",
        label: `${opts.length + 1}. ? 查看命令帮助 (/help)`,
        act: () => {
          appendMessageImmediate(HELP_TEXT);
        },
      });
      return opts;
    }

    return [];
  })();

  const selectorActive = activeOptions.length > 0;

  // 监听底层 stdin 原始字节流以捕获 SGR 鼠标滚轮事件（Ink 的 parseKeypress 会吞掉 \x1b[<64;...M 控制序列）
  useEffect(() => {
    if (!stdin) return;
    const onData = (chunk: Buffer | string) => {
      const raw = String(chunk);
      const matches = [...raw.matchAll(SGR_MOUSE_GLOBAL_RE)];
      if (matches.length > 0) {
        for (const m of matches) {
          const code = Number(m[1]);
          if (code === 64) scrollBy(3);
          else if (code === 65) scrollBy(-3);
        }
      }
    };
    stdin.on("data", onData);
    return () => {
      stdin.off("data", onData);
    };
  }, [stdin]);

  useInput((ch, key) => {
    if (key.tab) {
      const suffix = commandSuffix(input);
      if (suffix) {
        setInput(input + suffix);
        setInputEpoch((value) => value + 1);
      }
      return;
    }
    if (key.ctrl && ch === "t") {
      setTools((value) => !value);
      return;
    }
    // 解析 SGR 鼠标滚轮事件（64: 向上滚轮，65: 向下滚轮）
    const mouseMatches = [...ch.matchAll(SGR_MOUSE_GLOBAL_RE)];
    if (mouseMatches.length > 0) {
      for (const m of mouseMatches) {
        const code = Number(m[1]);
        if (code === 64) scrollBy(3);
        else if (code === 65) scrollBy(-3);
      }
      return;
    }

    if (key.escape) {
      setInput("");
      if (isApprovalPending) {
        setEditingApproval(false);
        setSelectedIndex(0);
      } else if (!credential) {
        setMenuMode("project_list");
        setSelectedIndex(0);
      }
      return;
    }
    if (key.pageUp || (key.ctrl && ch === "u")) {
      scrollBy(5);
      return;
    }
    if (key.pageDown || (key.ctrl && ch === "d")) {
      scrollBy(-5);
      return;
    }
    if (selectorActive && input === "") {
      if (key.downArrow) {
        setSelectedIndex((i) => (i + 1) % activeOptions.length);
      } else if (key.upArrow) {
        setSelectedIndex(
          (i) => (i - 1 + activeOptions.length) % activeOptions.length,
        );
      }
    }
  });

  function handleInputChange(nextValue: string) {
    // 拦截并剥离任何混入输入框的 SGR 鼠标控制序列（防止滚轮或点击向输入框注入字符）
    if (SGR_MOUSE_GLOBAL_RE.test(nextValue)) {
      const cleaned = nextValue.replace(SGR_MOUSE_GLOBAL_RE, "");
      setInput(cleaned);
      return;
    }

    if (selectorActive && input === "") {
      if (nextValue === "j") {
        setSelectedIndex((i) => (i + 1) % activeOptions.length);
        return;
      }
      if (nextValue === "h" || nextValue === "k") {
        setSelectedIndex(
          (i) => (i - 1 + activeOptions.length) % activeOptions.length,
        );
        return;
      }
      if (nextValue === "+" || nextValue === "=") {
        setBoxMinHeight((h) => Math.min(Math.max(6, totalRows - 5), h + 2));
        return;
      }
      if (nextValue === "-") {
        setBoxMinHeight((h) => Math.max(3, h - 2));
        return;
      }
    }
    setInput(nextValue);
  }

  async function submit(rawText: string) {
    const text = rawText.replace(SGR_MOUSE_GLOBAL_RE, "").trim();
    if (busy) return;

    if (!text && selectorActive) {
      const chosen = activeOptions[selectedIndex] ?? activeOptions[0];
      if (chosen) {
        await chosen.act();
      }
      return;
    }

    if (isApprovalPending && editingApproval && text && !text.startsWith("/")) {
      setInput("");
      setEditingApproval(false);
      await submit(`/approve ${text}`);
      return;
    }

    if (!text) return;
    setInput("");
    setBusy(true);
    setError("");
    try {
      if (text === "/quit") {
        exit();
        return;
      }
      if (text === "/help") {
        if (!credential) setHomeHelp(true);
        appendMessageImmediate(HELP_TEXT);
        return;
      }
      if (text.startsWith("/size")) {
        const arg = Number(text.slice(5).trim());
        if (Number.isFinite(arg) && arg >= 3 && arg <= 30) {
          setBoxMinHeight(Math.floor(arg));
          appendMessageImmediate(
            `输入框最小高度已调整为 ${Math.floor(arg)} 行`,
          );
        } else {
          setBoxMinHeight((h) => (h <= 4 ? 8 : 4));
        }
        return;
      }
      if (text === "/save" || text.startsWith("/save ")) {
        if (!credential) throw new Error("请先打开项目。");
        const latest = (await request(
          `/api/research/tasks/${credential.id}`,
          credential,
        )) as Task;
        const path = await saveReport(latest, text.slice(5));
        appendMessageImmediate(`已保存报告：${path}`);
        return;
      }
      if (text === "/tools") {
        setTools((v) => !v);
        return;
      }
      if (text === "/projects") {
        await loadProjects();
        resetProjectView();
        setMenuMode("project_list");
        setSelectedIndex(0);

        return;
      }
      if (text === "/back" || text === "/close") {
        resetProjectView();
        await loadProjects();
        setMenuMode("project_list");
        setSelectedIndex(0);
        return;
      }
      if (text === "/new") {
        resetProjectView();
        setMenuMode("text_input");

        return;
      }
      if (text.startsWith("/open ")) {
        const targetArg = text.slice(6).trim();
        const list = await loadProjects();
        let next = resolveTargetProject(targetArg, list);
        if (!next && /^[0-9a-f-]{36}$/i.test(targetArg)) {
          next = JSON.parse(
            await readFile(join(directory, targetArg + ".json"), "utf8"),
          ) as Credential;
        }
        if (!next) throw new Error("未找到对应项目，请用 /projects 查看列表");
        await openProjectRecord(next);
        return;
      }
      if (
        text === "/delete" ||
        text.startsWith("/delete ") ||
        text === "/rm" ||
        text.startsWith("/rm ")
      ) {
        const targetArg = text.replace(/^\/(delete|rm)\s*/, "").trim();
        const list = await loadProjects();
        if (!targetArg && !credential) {
          if (list.length === 0) throw new Error("当前没有可删除的项目");
          setMenuMode("delete_project");
          setSelectedIndex(0);
          return;
        }
        const target = targetArg
          ? resolveTargetProject(targetArg, list)
          : (credential ?? undefined);
        if (!target) {
          throw new Error("请指定要删除的项目序号或 ID，例如 /delete 1");
        }
        await deleteProjectRecord(target);
        return;
      }
      if (text === "/approval") {
        appendMessageImmediate(
          task?.approval
            ? "审批详情\n" +
                task.approval.reason +
                (task.approval.query &&
                task.approval.query !== task.approval.reason
                  ? "\n查询：" + task.approval.query
                  : "") +
                (task.approval.goal
                  ? "\n初始目标：" + task.approval.goal
                  : "") +
                (task.approval.serves
                  ? "\n这一跳回答：" + task.approval.serves
                  : "") +
                (task.approval.question &&
                task.approval.question !== task.approval.reason
                  ? "\n问题：" + task.approval.question
                  : "")
            : "当前没有待审批事项",
        );
        return;
      }
      if (text === "/continue" || text.startsWith("/continue ")) {
        if (!credential) throw new Error("请先打开有报告的项目。");
        await request(
          `/api/research/tasks/${credential.id}/continue`,
          credential,
          {
            instructions: text.slice("/continue".length).trim(),
            actor: "CLI",
          },
        );
        appendMessageImmediate(
          `❯ ${text}\n已根据上一轮所需证据启动新一轮研究。`,
        );
        return;
      }
      if (text === "/cite" || text.startsWith("/cite ")) {
        if (!credential) throw new Error("请先打开项目。");
        const current =
          task ??
          ((await request(
            `/api/research/tasks/${credential.id}`,
            credential,
          )) as Task);
        const sources = current.snapshot?.state?.sources ?? [];
        if (sources.length === 0) {
          appendMessageImmediate(
            "当前任务没有可引用的来源片段（可能未启用本地检索）。",
          );
          return;
        }
        const arg = text.slice(5).trim();
        if (!arg || arg === "list") {
          appendMessageImmediate(buildSourcesIndex(sources));
          return;
        }
        const [rawTarget, mode] = arg.split(/\s+/);
        const numbered = sources.map((source, index) => ({
          source,
          index,
          number: citationNumber(source, index),
        }));
        const target = /^\d+$/.test(rawTarget ?? "")
          ? numbered.find((item) => item.number === Number(rawTarget))
          : numbered.find(
              (item) =>
                (item.source.documentId ?? "").includes(rawTarget ?? "") ||
                item.source.id === rawTarget,
            );
        if (!target) {
          appendMessageImmediate(
            `没有匹配「${rawTarget}」的来源。可用编号：${numbered
              .map((item) => `[${item.number}]`)
              .join(" ")}`,
          );
          return;
        }
        appendMessageImmediate(
          buildEvidenceCard(
            target.source,
            current.snapshot?.state?.analysis?.findings ?? [],
            { index: target.index, full: mode === "full" },
          ),
        );
        return;
      }
      if (text === "/report") {
        if (task?.report) {
          enqueueStreamingText(task.report);
        } else {
          appendMessageImmediate("当前项目尚无报告");
        }
        return;
      }
      if (text === "/history") {
        for (const t of task?.history ?? []) {
          appendMessageImmediate(`❯ ${t.question}\n${t.report}`);
        }
        return;
      }
      if (text.startsWith("/upload ")) {
        const path = resolve(
          text
            .slice(8)
            .trim()
            .replace(/^["']|["']$/g, "")
            .replace(/^~\//, homedir() + "/"),
        );
        if ((await stat(path)).size > 24000) throw new Error("文件限 24 KB");
        const bytes = await readFile(path);
        if (bytes.length > 24000) throw new Error("文件限 24 KB");
        const form = new FormData();
        form.append("file", new File([bytes], basename(path)));
        if (credential?.id) {
          form.append("projectId", credential.id);
        }
        const res = await fetch(base + "/api/rag/upload", {
          method: "POST",
          body: form,
        });
        const result = await res.json();
        if (!res.ok) throw new Error(result.error);
        appendMessageImmediate(
          `已索引 ${result.name}，可在提问中要求检索此文件。`,
        );
        return;
      }
      if (credential && text.startsWith("/approve")) {
        setEditingApproval(false);
        await request(
          `/api/research/tasks/${credential.id}/approve`,
          credential,
          {
            actor: "CLI",
            approvalId: task?.approval?.id,
            ...(text.slice(8).trim() ? { value: text.slice(8).trim() } : {}),
          },
        );
        return;
      }
      if (credential && (text === "/reject" || text === "/resume")) {
        setEditingApproval(false);
        await request(
          `/api/research/tasks/${credential.id}/${text.slice(1)}`,
          credential,
          { actor: "CLI", approvalId: task?.approval?.id },
        );
        return;
      }
      if (text.startsWith("/") && !text.startsWith("/new "))
        throw new Error("未知命令，输入 /help 查看可用命令");
      const question = text.startsWith("/new ") ? text.slice(5).trim() : text;
      if (!question) throw new Error("请输入项目问题内容");
      if (!credential || text.startsWith("/new ")) {
        const next = (await request("/api/research/tasks", null, {
          message: question,
          actor: "CLI",
        })) as Credential;
        const title = next.title || summarizeTitle(question);
        const record: Credential = {
          id: next.id,
          key: next.key,
          title,
          createdAt: new Date().toISOString(),
        };
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          join(directory, record.id + ".json"),
          JSON.stringify(record),
          { mode: 0o600 },
        );
        resetProjectView();
        setCredential(record);
        setTask(null);
        setMenuMode("text_input");
        await loadProjects();
      } else {
        await request(
          `/api/research/tasks/${credential.id}/followup`,
          credential,
          { message: question, actor: "CLI" },
        );
      }
      appendMessageImmediate(`❯ ${question}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const activeTitle = credential
    ? task?.title ||
      credential.title ||
      (task?.question ? summarizeTitle(task.question) : "未命名项目")
    : null;

  const spinner = SPINNER_FRAMES[animTick % SPINNER_FRAMES.length]!;
  const pulseDots = PULSE_DOTS[animTick % PULSE_DOTS.length]!;

  // 完整自动换行的审批信息
  const approvalReasonWrapped = task?.approval
    ? wrapAnsi(
        stripVTControlCharacters(`审批：${task.approval.reason}`),
        innerWidth,
        { hard: true },
      )
    : "";
  const approvalTargetRaw =
    task?.approval?.query || task?.approval?.question || "";
  const approvalTargetWrapped =
    task?.approval &&
    approvalTargetRaw &&
    approvalTargetRaw.trim() !== task.approval.reason.trim()
      ? wrapAnsi(
          stripVTControlCharacters(`内容：${approvalTargetRaw}`),
          innerWidth,
          { hard: true },
        )
      : "";
  const approvalGoalWrapped = task?.approval?.goal
    ? wrapAnsi(
        stripVTControlCharacters(`初始目标：${task.approval.goal}`),
        innerWidth,
        { hard: true },
      )
    : "";
  const approvalServesWrapped = task?.approval?.serves
    ? wrapAnsi(
        stripVTControlCharacters(`这一跳回答：${task.approval.serves}`),
        innerWidth,
        { hard: true },
      )
    : "";
  const approvalQuestionsWrapped =
    task?.approval?.questions && task.approval.questions.length > 0
      ? wrapAnsi(
          stripVTControlCharacters(
            `未决问题：${task.approval.questions.join("；")}`,
          ),
          innerWidth,
          { hard: true },
        )
      : "";

  // 思考、RAG 查询与工具调用信息：放在主内容区，默认显示为折叠摘要行（不隐藏），输入 /tools 展开详情
  const hasProcessInfo = Boolean(
    credential &&
    task &&
    (task.audit.length > 0 ||
      task.turn?.query ||
      task.snapshot?.next ||
      isTaskRunning),
  );
  const processBlockText = hasProcessInfo
    ? [renderCallLog(task?.audit ?? [], tools)].filter(Boolean).join("\n\n")
    : "";

  // 计算底部输入框占用的行数，保证上方内容区精确适配可见窗口
  const approvalLineCount =
    task?.approval && task.status === "pending"
      ? (approvalReasonWrapped ? approvalReasonWrapped.split("\n").length : 0) +
        (approvalGoalWrapped ? approvalGoalWrapped.split("\n").length : 0) +
        (approvalServesWrapped ? approvalServesWrapped.split("\n").length : 0) +
        (approvalTargetWrapped ? approvalTargetWrapped.split("\n").length : 0) +
        (approvalQuestionsWrapped
          ? approvalQuestionsWrapped.split("\n").length
          : 0)
      : 0;
  const optionsLineCount =
    selectorActive && input === "" ? activeOptions.length : 0;
  const errorLineCount = error || task?.error ? 1 : 0;
  const estimatedBoxRows = Math.max(
    boxMinHeight,
    4 + approvalLineCount + optionsLineCount + errorLineCount,
  );
  // 预留 1 行给顶部 Header 状态栏
  const contentStatus = credential
    ? isTaskRunning
      ? `${spinner} ${describeActiveStep(task)}${pulseDots}`
      : busy
        ? "处理中…"
        : task?.status === "pending"
          ? "等待审批：请在下方选择操作"
          : task?.turn?.stop
            ? `执行结果：${task.turn.stop.message}`
            : task?.status === "completed"
              ? "✓ 本轮已完成"
              : task?.status === "ready"
                ? "待执行（尚未运行）"
                : (task?.status ?? "加载项目…")
    : "";
  const regionRows = Math.max(4, totalRows - estimatedBoxRows - 2);
  const viewportRows = regionRows - (contentStatus ? 1 : 0);

  // 实时流式预览与逐 token 输出中的文本
  const livePreviewSlice = rawPreviewText
    ? `生成中 · 尚未核验\n${rawPreviewText.slice(0, previewVisibleLen)}${previewVisibleLen < rawPreviewText.length ? "▍" : ""}`
    : "";
  const activeTypingSlice = activeTyping
    ? `${activeTyping.fullText.slice(0, activeTyping.visibleLen)}▍`
    : "";

  // 将思考/RAG查询/工具调用块放入主内容区（位于当前提问下方、最终报告上方）
  const sanitizedMessages = messages.map((m) => stripVTControlCharacters(m));
  const lastMsg = sanitizedMessages.at(-1);
  const lastIsReport = Boolean(
    lastMsg && /^(最终报告|报告更新)\n/.test(lastMsg),
  );
  const mainContentBlocks = lastIsReport
    ? [
        ...sanitizedMessages.slice(0, -1),
        ...(processBlockText
          ? [stripVTControlCharacters(processBlockText)]
          : []),
        lastMsg!,
      ]
    : [
        ...sanitizedMessages,
        ...(processBlockText
          ? [stripVTControlCharacters(processBlockText)]
          : []),
      ];

  const combinedText = !credential
    ? homeHelp
      ? HELP_TEXT
      : "\n  ATLAS\n  Research workspace\n\n  选择项目或输入新任务"
    : [
        ...mainContentBlocks,
        ...(livePreviewSlice
          ? [stripVTControlCharacters(livePreviewSlice)]
          : []),
        ...(activeTypingSlice
          ? [stripVTControlCharacters(activeTypingSlice)]
          : []),
      ].join("\n\n");

  const wrappedContentLines = combinedText
    ? wrapAnsi(combinedText, contentWidth, { hard: true }).split("\n")
    : [];

  const totalContentLines = wrappedContentLines.length;
  const maxScroll = Math.max(0, totalContentLines - viewportRows);
  maxScrollRef.current = maxScroll;
  const effectiveScroll = Math.min(scrollOffset, maxScroll);
  const endLineIdx = totalContentLines - effectiveScroll;
  const startLineIdx = Math.max(0, endLineIdx - viewportRows);
  const visibleSlice = wrappedContentLines.slice(startLineIdx, endLineIdx);

  // 补齐固定视口高度，确保底部输入框永远锚定在终端最底部不随内容行数变化而跳动
  const paddedLines = [
    ...visibleSlice,
    ...Array.from(
      { length: Math.max(0, viewportRows - visibleSlice.length) },
      () => "",
    ),
  ];

  // 计算右侧视觉滚动条滑块位置与大小
  const showScrollbar = totalContentLines > viewportRows;
  const thumbHeight = showScrollbar
    ? Math.max(
        1,
        Math.round(
          (viewportRows / Math.max(1, totalContentLines)) * viewportRows,
        ),
      )
    : viewportRows;
  const scrollProgress =
    maxScroll > 0 ? (maxScroll - effectiveScroll) / maxScroll : 1;
  const thumbStart = showScrollbar
    ? Math.min(
        viewportRows - thumbHeight,
        Math.round(scrollProgress * (viewportRows - thumbHeight)),
      )
    : 0;

  const statusTag = isTaskRunning
    ? (task?.status ?? "running")
    : busy
      ? "加载中"
      : task?.status === "ready"
        ? "待执行（尚未运行）"
        : task?.status === "queued"
          ? "排队中"
          : (task?.status ?? "就绪");

  const scrollIndicator =
    totalContentLines > 0
      ? `行 ${startLineIdx + 1}-${endLineIdx}/${totalContentLines}${effectiveScroll > 0 ? ` · ↑回看中 (滚轮/PgDn返回底部)` : ""}`
      : "就绪";

  return (
    <Box
      flexDirection="column"
      height={totalRows}
      justifyContent="space-between"
      overflow="hidden"
    >
      {/* 顶部独立状态与滚动位置栏 */}
      <Box justifyContent="space-between" paddingX={1}>
        <Text color="green" bold>
          ▣ Atlas CLI · {activeTitle ?? "项目工作台"}
        </Text>
        <Text dimColor>{scrollIndicator}</Text>
      </Box>

      {/* 中间固定高度可滚动内容区 + 右侧视觉滚动条 */}
      <Box
        flexDirection="row"
        height={regionRows}
        justifyContent="space-between"
        overflow="hidden"
      >
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {paddedLines.map((line, index) => (
            <Text
              key={index}
              {...(line.startsWith("• ")
                ? { color: "blueBright" }
                : /^ {2}[└+]/.test(line)
                  ? { color: "magentaBright", dimColor: true }
                  : {})}
            >
              {line || " "}
            </Text>
          ))}
          {contentStatus && (
            <Text color="cyan" wrap="truncate">
              {contentStatus}
            </Text>
          )}
        </Box>
        {showScrollbar && (
          <Box flexDirection="column" width={1} marginLeft={1}>
            {Array.from({ length: viewportRows }, (_, rowIdx) => {
              const isThumb =
                rowIdx >= thumbStart && rowIdx < thumbStart + thumbHeight;
              return (
                <Text
                  key={rowIdx}
                  {...(isThumb
                    ? { color: "cyan" as const }
                    : { dimColor: true })}
                >
                  {isThumb ? "┃" : "│"}
                </Text>
              );
            })}
          </Box>
        )}
      </Box>

      {/* 底部固定输入框（不随内容滚动） */}
      <Box
        flexDirection="column"
        borderStyle="single"
        paddingX={1}
        minHeight={boxMinHeight}
      >
        <Text color={isTaskRunning ? "cyan" : "green"} wrap="wrap">
          {activeTitle
            ? `${activeTitle} · ${statusTag}`
            : menuMode === "delete_project"
              ? `删除项目（j/h 上下选择，Enter 确认删除）`
              : `项目列表（${projects.length}） · j/h 选择并 Enter 确认，或输入 /help`}
        </Text>

        {task?.approval && task.status === "pending" && (
          <Box flexDirection="column">
            <Text color="yellow" wrap="wrap">
              {approvalReasonWrapped}
            </Text>
            {approvalGoalWrapped !== "" && (
              <Text color="yellow" wrap="wrap">
                {approvalGoalWrapped}
              </Text>
            )}
            {approvalServesWrapped !== "" && (
              <Text color="yellow" wrap="wrap">
                {approvalServesWrapped}
              </Text>
            )}
            {approvalTargetWrapped !== "" && (
              <Text color="yellow" wrap="wrap">
                {approvalTargetWrapped}
              </Text>
            )}
            {approvalQuestionsWrapped !== "" && (
              <Text color="yellow" wrap="wrap">
                {approvalQuestionsWrapped}
              </Text>
            )}
          </Box>
        )}

        {selectorActive && input === "" && (
          <Box flexDirection="column">
            {activeOptions.map((opt, idx) => {
              const active = idx === selectedIndex;
              return (
                <Text
                  key={opt.id}
                  {...(active
                    ? { color: "white" as const, backgroundColor: "#505050" }
                    : {})}
                  bold={active}
                  wrap="wrap"
                >
                  {active ? "❯ " : "  "}
                  {opt.label}
                </Text>
              );
            })}
          </Box>
        )}

        {(error || task?.error) && (
          <Text color="red" wrap="wrap">
            {error || task?.error}
          </Text>
        )}

        <Box>
          <Text>
            {editingApproval
              ? "修改/说明 ❯ "
              : selectorActive && input === ""
                ? "快捷输入 ❯ "
                : "❯ "}
          </Text>
          <TextInput
            key={inputEpoch}
            showCursor={!commandSuffix(input)}
            value={input}
            onChange={handleInputChange}
            onSubmit={(text) => void submit(text)}
          />
          {commandSuffix(input) && <Text dimColor>{commandSuffix(input)}</Text>}
        </Box>
      </Box>
    </Box>
  );
}
