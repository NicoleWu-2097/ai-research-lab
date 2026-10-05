import { useEffect, useRef, useState, type FormEvent } from "react";
import { readResearchStream, type ResearchEvent } from "./research-stream";

export function ResearchForm() {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("idle");
  const [taskId, setTaskId] = useState("");
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [toolEvents, setToolEvents] = useState<string[]>([]);
  const [sources, setSources] = useState<NonNullable<ResearchEvent["sources"]>>(
    [],
  );
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
    setToolEvents([]);
    setSources([]);
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
        if (
          event.type.startsWith("TOOL") ||
          event.type === "SOURCES_COLLECTED" ||
          event.type.startsWith("RETRIEVAL_") ||
          event.type === "CITATIONS_VALIDATED"
        ) {
          setToolEvents((items) => [...items, event.message ?? event.type]);
        }
        if (event.type === "RETRIEVAL_COMPLETED")
          setSources(event.sources ?? []);
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
        输入研究问题，获得初步分析。启用本地检索后，报告可引用文档片段；当前不搜索互联网，结论仍需核验。
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
      {toolEvents.length > 0 && (
        <details open>
          <summary>工具活动</summary>
          <ol>
            {toolEvents.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </details>
      )}
      {report && (
        <article aria-label="初步研究报告">
          {status !== "completed" && <p>以下内容为尚未完成校验的草稿。</p>}
          <pre>{report}</pre>
        </article>
      )}
      {sources.length > 0 && (
        <section aria-label="检索来源">
          <h2>检索来源</h2>
          {sources.map((source) => (
            <details key={source.id}>
              <summary>
                {source.documentId}：第 {source.startLine}–{source.endLine} 行
              </summary>
              <p>引用：[{source.id}]</p>
              <p>片段 ID：{source.chunkId}</p>
              <small>
                原文 SHA-256：{source.sha256} · 相似度：
                {source.score.toFixed(3)}
              </small>
              <pre>{source.content}</pre>
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
