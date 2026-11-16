import type { StopReason } from "../research/report.js";
/** 原始消息与后续 agent 决策分开；null 表示尚未判断，不暗示需要研究。 */
export type MessageIntent = "summarize" | "edit" | "research" | "clarify";
export type ReportQuality =
  "none" | "unreviewed" | "reviewed" | "unverified" | "insufficient";
export type ContentKind =
  "user_message" | "status" | "approval" | "tool" | "rag" | "report";
export interface TurnMetadata {
  stop?: StopReason;
  routing?: {
    phase: "ready" | "inflight";
    calls: number;
    units: number;
    retries: number;
    elapsedMs: number;
  };
  id: string;
  message: string;
  intent: MessageIntent | null;
  goal: string | null;
  query: string | null;
  basedOnReportId: string | null;
  basedOnReportRevision: number | null;
  report: { id: string; revision: number; quality: ReportQuality };
}
export interface ContentEventMetadata {
  roundId: string;
  kind: ContentKind;
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
  const base = stripped || firstClause || "未命名项目";
  return base.length > 28 ? `${base.slice(0, 28)}…` : base;
}

export function newTurn(
  projectId: string,
  number: number,
  message: string,
  basedOnReportId: string | null = null,
  basedOnReportRevision: number | null = null,
): TurnMetadata {
  const id = `${projectId}:turn:${number}`;
  return {
    id,
    message,
    intent: null,
    goal: null,
    query: null,
    basedOnReportId,
    basedOnReportRevision,
    report: { id: `${id}:report`, revision: 0, quality: "none" },
  };
}
export function contentKind(
  action: string,
  detail: Record<string, unknown>,
): ContentKind {
  if (action === "created" || action === "followup") return "user_message";
  if (
    ["approval_requested", "approved", "rejected", "expired"].includes(action)
  )
    return "approval";
  if (action.startsWith("REPORT_") || action === "completed") return "report";
  if (
    action.startsWith("RAG_") ||
    (action.startsWith("RETRIEVAL_") && detail.action === "local")
  )
    return "rag";
  if (/^(TOOL_|MCP_|RETRIEVAL_)/.test(action)) return "tool";
  return "status";
}
