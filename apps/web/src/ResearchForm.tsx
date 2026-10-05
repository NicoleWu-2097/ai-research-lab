import { useEffect, useRef, useState, type FormEvent } from "react";
import { readResearchStream } from "./research-stream";

export function ResearchForm() {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("idle");
  const [taskId, setTaskId] = useState("");
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), []);
  const busy = status === "starting" || status === "running";

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (current.current) return;
    const controller = new AbortController();
    current.current = controller;
    setStatus("starting");
    setTaskId("");
    setReport("");
    setError("");
    try {
      const response = await fetch("/api/research/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(
          response.status === 503
            ? "请先配置模型服务。"
            : `请求失败（HTTP ${response.status}）`,
        );
      await readResearchStream(response, (event) => {
        if (controller.signal.aborted) return;
        setTaskId(event.taskId);
        if (event.type === "AGENT_STARTED") setStatus("running");
        if (event.type === "REPORT_DELTA")
          setReport((value) => value + (event.text ?? ""));
        if (event.type === "AGENT_COMPLETED") {
          setReport(event.report ?? "");
          setStatus("completed");
        }
        if (event.type === "AGENT_FAILED") {
          setStatus("failed");
          setError(event.message ?? "研究失败");
        }
        if (event.type === "TASK_CANCELLED") setStatus("cancelled");
      });
    } catch (error) {
      setStatus(controller.signal.aborted ? "cancelled" : "failed");
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : "请求失败");
    } finally {
      current.current = null;
    }
  }

  return (
    <section>
      <p>
        输入研究问题，获得初步分析。当前结果仅基于模型知识，尚未检索或核验外部证据。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="question">研究问题</label>
        <textarea
          id="question"
          required
          maxLength={8000}
          value={question}
          disabled={busy}
          onChange={(event) => setQuestion(event.target.value)}
          rows={4}
        />
        <button type="submit" disabled={busy || !question.trim()}>
          开始研究
        </button>
        {busy && (
          <button type="button" onClick={() => current.current?.abort()}>
            取消
          </button>
        )}
      </form>
      <p role="status">研究状态：{status}</p>
      {taskId && <small>任务 ID：{taskId}</small>}
      {error && <p role="alert">{error}</p>}
      {report && (
        <article aria-label="初步研究报告">
          <pre>{report}</pre>
        </article>
      )}
    </section>
  );
}
