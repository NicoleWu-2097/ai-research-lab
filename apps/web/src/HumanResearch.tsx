import { DocumentUpload } from "./DocumentUpload";
import { useEffect, useRef, useState } from "react";
interface Task {
  id: string;
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
export function HumanResearch() {
  const outputRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [actor, setActor] = useState("本机用户");
  const [clarify, setClarify] = useState(false);
  const [credential, setCredential] = useState<{
    id: string;
    key: string;
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
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);
  const [events, setEvents] = useState<Task["audit"]>([]);
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
        const body = await response.json();
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
    setBusy(true);
    setError("");
    try {
      const response = await fetch(
        action
          ? `/api/research/tasks/${credential!.id}/${action}`
          : "/api/research/tasks",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(credential && action
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
                  question: attachments.length
                    ? `${question}\n请优先检索本地上传资料：${attachments.join("、")}`
                    : question,
                  clarify,
                },
          ),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "操作失败");
      if (!action) {
        localStorage.setItem("human-research", JSON.stringify(body));
        setCredential(body);
        setTask(null);
        setAttachments([]);
      }
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  // 只在可见内容变化时滚动，避免轮询重复响应让历史阅读不断跳动。
  useEffect(() => {
    const output = outputRef.current;
    if (output) output.scrollTop = output.scrollHeight;
  }, [events.length, task?.report, task?.status, task?.approval?.id, error]);
  return (
    <section className="terminal-workspace">
      <div
        ref={outputRef}
        className="terminal-output"
        role="log"
        aria-label="研究终端输出"
        tabIndex={0}
      >
        {!task && (
          <div className="terminal-welcome">
            <p>AI Research Lab</p>
            <p>提出问题 → 确认计划 → 跟随证据 → 阅读报告</p>
            <p>在下方输入问题，研究过程将在这里持续输出。</p>
          </div>
        )}
        {task && (
          <>
            <p className="terminal-prompt">❯ {task.question}</p>
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
                : "❯ 就绪"}
          </span>
          {credential && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setTick((t) => t + 1)}
            >
              刷新任务
            </button>
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
              disabled={busy || !actor.trim() || !value.trim()}
              onClick={() => void send("approve")}
            >
              批准并继续
            </button>
            <button
              className="secondary"
              disabled={busy || !actor.trim()}
              onClick={() => void send("reject")}
            >
              拒绝并结束
            </button>
          </section>
        )}
        {task && ["queued", "ready", "running"].includes(task.status) && (
          <button
            disabled={busy || !actor.trim()}
            onClick={() => void send("resume")}
          >
            重启后恢复 / 检查执行状态
          </button>
        )}
        {task?.status !== "pending" && (
          <div className="composer">
            {" "}
            <label>
              操作人（本机自报名称，非登录认证）
              <input
                value={actor}
                maxLength={80}
                onChange={(e) => setActor(e.target.value)}
              />
            </label>
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
                  placeholder="提出一个问题，例如：联网研究 PostgreSQL 最新版本的主要变化…"
                  rows={3}
                  maxLength={8000}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={clarify}
                  onChange={(e) => setClarify(e.target.checked)}
                />
                开始前先澄清研究范围
              </label>
              <button
                disabled={
                  busy ||
                  !question.trim() ||
                  !actor.trim() ||
                  task?.status === "running" ||
                  task?.status === "pending"
                }
              >
                新建研究
              </button>
            </form>
          </div>
        )}
        <p className="storage-note">
          当前任务保存在此浏览器 · 新研究为独立任务
        </p>
      </div>
    </section>
  );
}
