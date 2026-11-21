import { DocumentUpload } from "./DocumentUpload";
import { useEffect, useRef, useState } from "react";

interface ProjectItem {
  id: string;
  key: string;
  title: string;
  updatedAt?: string;
}

interface Task {
  id: string;
  title?: string;
  question: string;
  status: string;
  report: string;
  error: string;
  approval: {
    id: string;
    kind: string;
    query: string;
    question: string;
    questions: string[];
    reason: string;
    expiresAt: string;
    goal?: string;
    serves?: string;
  } | null;
  snapshot?: {
    next?: string;
    phase?: string;
    calls?: number;
    units?: number;
    retries?: number;
    state: {
      sources: {
        id: string;
        url?: string;
        title?: string;
        sourceKind?: string;
        documentId: string;
        content: string;
        startLine: number;
        endLine: number;
      }[];
    };
  } | null;
  audit: {
    seq: number;
    actor: string;
    action: string;
    created_at: string;
    detail?: Record<string, unknown>;
  }[];
}

export function summarizeProjectTitle(message: string): string {
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

const HELP_MESSAGE = [
  "命令帮助 (/help)：",
  "  • 直接输入内容：在项目列表中将创建新项目；在项目内则继续追问或修改报告",
  "  • /projects：返回并查看项目列表",
  "  • /new [问题]：创建新项目",
  "  • /delete：删除当前项目",
  "  • /help：显示本帮助说明",
].join("\n");

export function HumanResearch() {
  const outputRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const actor = "本机用户";
  const [projects, setProjects] = useState<ProjectItem[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem("human-research-projects") ?? "[]",
      );
    } catch {
      return [];
    }
  });
  const [credential, setCredential] = useState<{
    id: string;
    key: string;
    title?: string;
  } | null>(() => {
    try {
      return JSON.parse(localStorage.getItem("human-research") ?? "null");
    } catch {
      return null;
    }
  });
  const [task, setTask] = useState<Task | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [helpShown, setHelpShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [events, setEvents] = useState<Task["audit"]>([]);

  function saveProjectsList(nextList: ProjectItem[]) {
    setProjects(nextList);
    try {
      localStorage.setItem("human-research-projects", JSON.stringify(nextList));
    } catch {
      // ignore storage quota errors
    }
  }

  function openProject(item: ProjectItem) {
    setCredential(item);
    setTask(null);
    setEvents([]);
    setHelpShown(false);
  }

  function exitToProjectList() {
    localStorage.removeItem("human-research");
    setCredential(null);
    setTask(null);
    setEvents([]);
  }

  async function deleteProject(target: { id: string; key: string }) {
    setBusy(true);
    setError("");
    try {
      await fetch(`/api/research/tasks/${target.id}`, {
        method: "DELETE",
        headers: { "x-research-key": target.key },
      }).catch(() => undefined);
      const nextList = projects.filter((p) => p.id !== target.id);
      saveProjectsList(nextList);
      if (credential?.id === target.id) {
        exitToProjectList();
      }
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!credential) return;
    const controller = new AbortController();
    let cursor = 0;
    const history: Task["audit"] = [];
    setEvents([]);
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch(`/api/research/tasks/${credential.id}`, {
          headers: { "x-research-key": credential.key },
          signal: controller.signal,
        });
        const body = (await response.json()) as Task & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "查询失败");
        if (!controller.signal.aborted) {
          const eventResponse = await fetch(
            `/api/research/tasks/${credential.id}/events?after=${cursor}`,
            {
              headers: { "x-research-key": credential.key },
              signal: controller.signal,
            },
          );
          if (!eventResponse.ok) throw new Error("事件补载失败");
          const eventText = await eventResponse.text();
          for (const line of eventText.split("\n")) {
            if (!line.startsWith("data: ")) continue;
            const item = JSON.parse(line.slice(6)) as Task["audit"][number];
            if (Number(item.seq) > cursor) {
              history.push(item);
              cursor = Number(item.seq);
            }
          }
          if (controller.signal.aborted) return;
          const resolvedTitle =
            body.title ||
            credential.title ||
            summarizeProjectTitle(body.question || "未命名项目");
          body.title = resolvedTitle;
          setEvents([...history]);
          setTask(body);
          setError("");
          timer = setTimeout(() => void poll(), 1500);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : "查询失败");
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [credential, tick]);

  useEffect(() => {
    setValue(
      task?.approval?.kind === "clarification"
        ? task.approval.question
        : (task?.approval?.query ?? ""),
    );
  }, [task?.approval?.id]);

  async function send(action?: "approve" | "reject" | "resume") {
    const trimmed = question.trim();
    if (!action) {
      if (trimmed === "/help") {
        setHelpShown(true);
        setQuestion("");
        return;
      }
      if (trimmed === "/projects" || trimmed === "/back") {
        exitToProjectList();
        setQuestion("");
        return;
      }
      if (trimmed === "/delete" && credential) {
        setQuestion("");
        await deleteProject(credential);
        return;
      }
    }

    setBusy(true);
    setError("");
    try {
      const cleanQuestion = trimmed.startsWith("/new ")
        ? trimmed.slice(5).trim()
        : trimmed;
      const isFollowup =
        !action && Boolean(credential) && !trimmed.startsWith("/new ");
      const endpoint = action
        ? `/api/research/tasks/${credential!.id}/${action}`
        : isFollowup
          ? `/api/research/tasks/${credential!.id}/followup`
          : "/api/research/tasks";

      const promptWithAttachments = attachments.length
        ? `${cleanQuestion}\n请优先检索本地上传资料：${attachments.join("、")}`
        : cleanQuestion;

      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(credential && (action || isFollowup)
            ? { "x-research-key": credential.key }
            : {}),
        },
        body: JSON.stringify(
          action
            ? {
                actor,
                approvalId: task?.approval?.id,
                ...(action === "approve" ? { value } : {}),
              }
            : {
                actor,
                question: promptWithAttachments,
              },
        ),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "操作失败");
      if (!action && !isFollowup) {
        const title =
          body.title || summarizeProjectTitle(cleanQuestion || "未命名项目");
        const newProj: ProjectItem = {
          id: body.id,
          key: body.key,
          title,
          updatedAt: new Date().toISOString(),
        };
        saveProjectsList([
          newProj,
          ...projects.filter((p) => p.id !== newProj.id),
        ]);
        setCredential(newProj);
        setTask(null);
        setAttachments([]);
      }
      if (!action) {
        setQuestion("");
      }
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [
    events.length,
    task?.report,
    task?.status,
    task?.approval?.id,
    error,
    helpShown,
  ]);

  const activeTitle =
    task?.title ||
    credential?.title ||
    (task?.question ? summarizeProjectTitle(task.question) : null);

  return (
    <section className="terminal-workspace">
      <div
        ref={outputRef}
        className="terminal-output"
        role="log"
        aria-label="研究终端输出"
        tabIndex={0}
      >
        {!task && !credential && (
          <div className="terminal-welcome">
            <p>项目列表（共 {projects.length} 个项目）</p>
            {projects.length === 0 ? (
              <p>
                暂无项目，在下方直接输入问题新建项目，或输入 /help 查看帮助。
              </p>
            ) : (
              <ul>
                {projects.map((p, index) => (
                  <li key={p.id}>
                    {index + 1}. {p.title} <small>({p.id.slice(0, 8)})</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {helpShown && <pre aria-label="帮助信息">{HELP_MESSAGE}</pre>}
        {task && (
          <>
            <p className="terminal-prompt">
              ❯ {activeTitle ?? summarizeProjectTitle(task.question)}
            </p>
            <p role="status">任务状态：{task.status}</p>
            <small>任务 ID：{task.id}</small>
            <ol className="conversation-events" aria-label="研究对话">
              {(events.length ? events : task.audit).map((e) => (
                <li key={e.seq}>
                  <span className="event-marker">·</span>
                  <div>
                    <small>
                      {e.actor} · {e.action}
                    </small>
                    <span>
                      {typeof e.detail?.message === "string"
                        ? e.detail.message
                        : typeof e.detail?.node === "string"
                          ? e.detail.node
                          : e.action}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
            {task.snapshot && (
              <p className="terminal-meter">
                节点 {task.snapshot.next ?? "—"} · 调用{" "}
                {task.snapshot.calls ?? 0} · 文本预留 {task.snapshot.units ?? 0}{" "}
                · 重试 {task.snapshot.retries ?? 0}
              </p>
            )}
            {task.approval && task.status === "pending" && (
              <p className="terminal-notice">
                等待审批：{task.approval.reason} 请在底部确认。
              </p>
            )}
            {task.error && <p role="alert">{task.error}</p>}
            {task.report && (
              <pre className="report-message" aria-label="研究报告">
                {task.report}
              </pre>
            )}
            {task.snapshot?.state.sources.map((source) => (
              <div className="terminal-source" key={source.id}>
                <p>
                  [{source.id}] {source.title ?? source.documentId}
                  {source.url
                    ? " · 搜索摘要（非网页全文）"
                    : ` · 第 ${source.startLine}–${source.endLine} 行`}
                </p>
                <pre>{source.content}</pre>
              </div>
            ))}
          </>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="terminal-dock" aria-label="研究操作区">
        <div className="dock-toolbar">
          <span>
            {task?.status === "pending"
              ? "? 等待你的决定"
              : task?.status === "running"
                ? "● 研究进行中"
                : activeTitle
                  ? `当前项目：${activeTitle}`
                  : "❯ 项目列表"}
          </span>
          {!credential && projects.length > 0 && (
            <div>
              {projects.map((p) => (
                <span key={p.id}>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => openProject(p)}
                  >
                    打开：{p.title}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
                    onClick={() => void deleteProject(p)}
                  >
                    删除
                  </button>
                </span>
              ))}
            </div>
          )}
          {credential && (
            <div>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setTick((t) => t + 1)}
              >
                刷新任务
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={exitToProjectList}
              >
                项目列表
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => void deleteProject(credential)}
              >
                删除项目
              </button>
            </div>
          )}
        </div>
        {task?.approval && task.status === "pending" && (
          <section className="approval-card" aria-label="待审批请求">
            <span className="eyebrow">● APPROVAL REQUIRED</span>
            <h3>
              {
                {
                  clarification: "澄清研究范围",
                  plan: "确认研究计划",
                  plan_adjustment: "确认补充研究",
                  tool: "确认工具或联网访问",
                }[task.approval.kind]
              }
            </h3>
            <p>{task.approval.reason}</p>
            {task.approval.goal && <p>初始目标：{task.approval.goal}</p>}
            {task.approval.serves && <p>这一跳回答：{task.approval.serves}</p>}
            <ul>
              {task.approval.questions.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
            <p>到期：{new Date(task.approval.expiresAt).toLocaleString()}</p>
            <label>
              {task.approval.kind === "clarification"
                ? "确认后的问题"
                : "执行查询（可调整）"}
              <textarea
                maxLength={8000}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
            <button
              disabled={busy || !value.trim()}
              onClick={() => void send("approve")}
            >
              批准并继续
            </button>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void send("reject")}
            >
              拒绝并结束
            </button>
          </section>
        )}
        {task && ["queued", "ready", "running"].includes(task.status) && (
          <button disabled={busy} onClick={() => void send("resume")}>
            重启后恢复 / 检查执行状态
          </button>
        )}
        {task?.status !== "pending" && (
          <div className="composer">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <DocumentUpload
                disabled={busy}
                onUploaded={(name) =>
                  setAttachments((items) => [...new Set([...items, name])])
                }
              />
              {attachments.length > 0 && (
                <small>已附资料：{attachments.join("、")}</small>
              )}
              <label>
                研究问题
                <textarea
                  required
                  placeholder="输入问题或 /help 查看命令…"
                  rows={2}
                  maxLength={8000}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <button
                disabled={
                  busy ||
                  !question.trim() ||
                  task?.status === "running" ||
                  task?.status === "pending"
                }
              >
                {credential ? "发送" : "新建项目"}
              </button>
            </form>
          </div>
        )}
      </div>
    </section>
  );
}
