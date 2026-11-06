import { useEffect, useState } from "react";
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
    state: {
      sources: {
        id: string;
        documentId: string;
        content: string;
        startLine: number;
        endLine: number;
      }[];
    };
  } | null;
  audit: { seq: number; actor: string; action: string; created_at: string }[];
}
export function HumanResearch() {
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
  useEffect(() => {
    if (!credential) return;
    const controller = new AbortController();
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
          setTask(body);
          timer = setTimeout(() => void poll(), 1500);
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "查询失败");
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
              : { actor, question, clarify },
          ),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "操作失败");
      if (!action) {
        localStorage.setItem("human-research", JSON.stringify(body));
        setCredential(body);
        setTask(null);
      }
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h2>人工介入研究</h2>
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
        <label>
          研究问题
          <textarea
            required
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
      {credential && (
        <button disabled={busy} onClick={() => setTick((t) => t + 1)}>
          刷新任务
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {task && (
        <>
          <p role="status">任务状态：{task.status}</p>
          <p>任务 ID：{task.id}</p>
          <p>{task.question}</p>
          {task.approval && task.status === "pending" && (
            <section aria-label="待审批请求">
              <h3>
                {
                  {
                    clarification: "澄清研究范围",
                    plan: "确认研究计划",
                    plan_adjustment: "确认补充研究",
                    tool: "确认 MCP 文档访问",
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
                disabled={busy || !actor.trim()}
                onClick={() => void send("reject")}
              >
                拒绝并结束
              </button>
            </section>
          )}
          {["queued", "ready", "running"].includes(task.status) && (
            <button
              disabled={busy || !actor.trim()}
              onClick={() => void send("resume")}
            >
              重启后恢复 / 检查执行状态
            </button>
          )}
          {task.error && <p role="alert">{task.error}</p>}
          {task.report && (
            <pre>
              {task.report.split(/(\[RAG:[1-8]\])/g).map((part, index) => {
                const source = task.snapshot?.state.sources.find(
                  (s) => `[${s.id}]` === part,
                );
                return source ? (
                  <a
                    key={index}
                    href={`#human-source-${source.id}`}
                    onClick={() =>
                      document
                        .getElementById(`human-source-${source.id}`)
                        ?.setAttribute("open", "")
                    }
                  >
                    {part}
                  </a>
                ) : (
                  part
                );
              })}
            </pre>
          )}
          {task.snapshot?.state.sources.map((source) => (
            <details key={source.id} id={`human-source-${source.id}`}>
              <summary>
                [{source.id}] {source.documentId}：第 {source.startLine}–
                {source.endLine} 行
              </summary>
              <pre>{source.content}</pre>
            </details>
          ))}
          <details>
            <summary>操作记录</summary>
            <ol>
              {task.audit.map((e) => (
                <li key={e.seq}>
                  {e.created_at} · {e.actor} · {e.action}
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
      <p>
        此浏览器会保存当前任务的访问密钥，刷新后可继续审批。请勿共享访问密钥。
      </p>
    </section>
  );
}
