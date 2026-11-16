import { DocumentUpload } from "./DocumentUpload";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { readResearchStream, type ResearchEvent } from "./research-stream";

export function ResearchForm() {
  const [attachments, setAttachments] = useState<string[]>([]);
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState("idle");
  const [taskId, setTaskId] = useState("");
  const [report, setReport] = useState("");
  const [error, setError] = useState("");
  const [toolEvents, setToolEvents] = useState<string[]>([]);
  const [artifacts, setArtifacts] = useState<string[]>([]);
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
    setArtifacts([]);
    setSources([]);
    try {
      const response = await fetch("/api/research/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: attachments.length
            ? `${question}\n请优先检索本地上传资料：${attachments.join("、")}`
            : question,
        }),
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
          event.type.startsWith("A2A_") ||
          event.type.startsWith("LOOP_") ||
          event.type === "SOURCES_COLLECTED" ||
          event.type.startsWith("RETRIEVAL_") ||
          event.type === "CITATIONS_VALIDATED" ||
          [
            "AGENT_DECISION",
            "EVIDENCE_ASSESSED",
            "RESEARCH_STOPPED",
            "ROLE_DELEGATED",
            "DRAFT_READY",
            "CRITIC_REVIEWED",
            "COORDINATOR_COMPLETED",
            "task_started",
            "plan_updated",
            "tool_started",
            "tool_completed",
            "tool_failed",
            "evidence_added",
            "verification_completed",
            "artifact_created",
          ].includes(event.type)
        ) {
          setToolEvents((items) => [...items, event.message ?? event.type]);
        }
        if (event.type === "artifact_created" && event.message) {
          setArtifacts((items) => [...items, event.message!]);
        }
        if (event.type === "RETRIEVAL_COMPLETED")
          setSources(event.sources ?? []);
        if (event.type === "AGENT_STARTED" || event.type === "task_started")
          setStatus("running");
        if (event.type === "REPORT_PREVIEW") setReport(event.report ?? "");
        if (event.type === "REPORT_DELTA")
          setReport((value) => value + (event.text ?? ""));
        if (event.type === "AGENT_COMPLETED" || event.type === "task_completed") {
          if (event.report) setReport(event.report);
          setStatus("completed");
        }
        if (event.type === "AGENT_FAILED" || event.type === "task_failed") {
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
        <DocumentUpload
          disabled={busy}
          onUploaded={(name) =>
            setAttachments((items) => [...new Set([...items, name])])
          }
        />
        {attachments.length > 0 && (
          <small>已附资料：{attachments.join("、")}</small>
        )}
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
          <summary>研究过程</summary>
          <ol>
            {toolEvents.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </details>
      )}
      {artifacts.length > 0 && (
        <section aria-label="生成文件">
          <h3>生成文件</h3>
          <ul>
            {artifacts.map((art, index) => (
              <li key={index}>{art}</li>
            ))}
          </ul>
        </section>
      )}
      {report && (
        <article aria-label="初步研究报告">
          {status !== "completed" && <p>以下内容为尚未完成校验的草稿。</p>}
          <pre>
            {report.split(/(\[RAG:[1-8]\])/g).map((part, index) => {
              const source = sources.find((s) => `[${s.id}]` === part);
              return source ? (
                <a
                  key={index}
                  href={`#source-${source.id}`}
                  onClick={() =>
                    document
                      .getElementById(`source-${source.id}`)
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
        </article>
      )}
      {sources.length > 0 && (
        <section aria-label="检索来源">
          <h2>检索来源</h2>
          {sources.map((source) => (
            <details key={source.id} id={`source-${source.id}`}>
              <summary>
                {source.documentId}：第 {source.startLine}–{source.endLine} 行
              </summary>
              <p>引用：[{source.id}]</p>
              <p>片段 ID：{source.chunkId}</p>
              <small>
                原文 SHA-256：{source.sha256}
                {source.score === null
                  ? " · MCP 文档片段"
                  : ` · 相似度：${source.score.toFixed(3)}`}
              </small>
              <pre>{source.content}</pre>
            </details>
          ))}
        </section>
      )}
    </section>
  );
}
