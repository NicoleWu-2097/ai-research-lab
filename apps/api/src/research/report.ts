import { z } from "zod";
import { ModelError } from "../model/types.js";
import { BudgetExceeded } from "./budget.js";
export type StopCode =
  | "evidence_gap"
  | "duplicate_query"
  | "budget"
  | "review_format"
  | "model_error"
  | "tool_error"
  | "timeout"
  | "cancelled"
  | "interrupted";
export interface StopReason {
  code: StopCode;
  message: string;
}
export function stopReason(error: unknown, node?: string): StopReason {
  if (error instanceof z.ZodError)
    return { code: "review_format", message: "模型输出格式未通过校验。" };
  if (error instanceof BudgetExceeded)
    return {
      code: "budget",
      message: "研究预算已用完，保留额度用于最终报告。",
    };
  if (error instanceof ModelError) {
    if (error.code === "MODEL_TIMEOUT")
      return { code: "timeout", message: "执行时间已用完。" };
    if (error.code === "MODEL_CANCELLED")
      return { code: "cancelled", message: "执行已取消。" };
    if (error.code === "MODEL_INVALID_OUTPUT")
      return { code: "review_format", message: "模型输出或引用校验未通过。" };
    return { code: "model_error", message: "模型服务调用失败。" };
  }
  const detail = error instanceof Error ? error.message.trim() : "";
  return {
    code: node === "research" ? "tool_error" : "model_error",
    message:
      node === "research"
        ? detail
          ? `检索工具调用失败。${detail}`
          : "检索工具调用失败。"
        : "研究执行未完成。",
  };
}
export function plannedStop(message: string): StopReason {
  return {
    code: /预算|轮次|来源/.test(message)
      ? "budget"
      : /重复|查询为空/.test(message)
        ? "duplicate_query"
        : /审查输出|结构化|校验/.test(message)
          ? "review_format"
          : "evidence_gap",
    message,
  };
}
export interface ReportInput {
  goal: string;
  draft?: string;
  partial?: boolean;
  sources?: readonly { id: string; content: string; documentId?: string }[];
  queries?: readonly string[];
  issues?: readonly string[];
}
/** 无模型依赖；失败、拒绝或时间耗尽时也可根据已保存成果生成结果。 */
export function fallbackReport(input: ReportInput): string {
  const sources = input.sources ?? [];
  const allowed = new Set(sources.map((s) => s.id));
  const draft = input.draft
    ?.trim()
    .replace(/\[(RAG:[^\]]+)\]/g, (mark, id: string) =>
      allowed.has(id) ? mark : "[引用待核验]",
    );
  const issues = [...new Set(input.issues ?? [])].filter(
    (issue) => !draft?.includes(issue),
  );
  if (draft)
    return [
      input.partial
        ? "【阶段报告】以下保留已生成内容，文本可能未完成，结论尚待核验。"
        : "【待核验报告】以下为已有成果，未完成全部核验。",
      draft,
      ...(issues.length
        ? [
            "## 待确认事项\n" +
              issues
                .slice(0, 6)
                .map((x) => "- " + x)
                .join("\n"),
          ]
        : []),
    ].join("\n\n");
  return [
    "# 研究阶段报告",
    "## 研究目标\n" + input.goal,
    "## 当前结论\n" +
      (sources.length
        ? "已取得以下资料片段，可作为后续分析依据；尚不能据此给出完整研究结论。"
        : "目前没有足够资料形成可核实的事实结论。"),
    "## 已完成工作\n" +
      ((input.queries?.length ?? 0)
        ? input.queries!.map((q) => "- 已完成检索：" + q).join("\n")
        : "已接收研究请求；尚无已完成的检索记录。"),
    ...(sources.length
      ? [
          "## 已有依据（原文片段）\n" +
            sources
              .slice(0, 8)
              .map(
                (s) =>
                  `- [${s.id}] ${s.documentId ?? "来源"}：${s.content.slice(0, 500)}`,
              )
              .join("\n"),
        ]
      : []),
    "## 尚缺材料与下一步\n" +
      (issues.length
        ? issues
            .slice(0, 6)
            .map((x) => "- " + x)
            .join("\n")
        : "- 补充与目标直接相关的资料，并核对主要结论。"),
  ].join("\n\n");
}

import { tokenizeText } from "../rag/hybrid.js";

function isRelatedFollowup(
  currentGoal: string,
  previousQuestion?: string,
): boolean {
  if (!previousQuestion) return false;
  if (
    /继续|刚才|补充|缩成|改成|修改|总结|short|revise|continue|more|followup/i.test(
      currentGoal,
    )
  ) {
    return true;
  }
  const prevTokens = new Set(tokenizeText(previousQuestion));
  const currTokens = tokenizeText(currentGoal);
  return currTokens.some((t) => prevTokens.has(t));
}

export function savedReport(task: import("../human/store.js").HumanTask) {
  const state = task.snapshot?.state;
  const previous = [...(task.history ?? [])]
    .reverse()
    .find((turn) => turn.report.trim());
  const current = state?.report || state?.draft || task.report;
  const currentGoal = task.turn.goal ?? task.turn.message;
  const related = isRelatedFollowup(currentGoal, previous?.question);
  const draft = current || (related ? previous?.report : "") || "";
  const sources = current
    ? state?.sources
    : related
      ? previous?.snapshot?.state.sources
      : [];
  return {
    report: appendWebSources(
      fallbackReport({
        goal: currentGoal,
        draft:
          !current && draft
            ? "本轮未形成新报告，保留上一轮成果：\n\n" + draft
            : draft,
        partial: !!current && !state?.report && !state?.draft,
        sources: sources ?? [],
        queries: state?.queries ?? [],
        issues: state?.analysis.unresolved ?? [],
      }),
      sources ?? [],
    ),
    quality: draft ? ("unverified" as const) : ("insufficient" as const),
  };
}

/** 只使用检索器提供的 URL，不接受模型臆造的来源地址。 */
export function appendWebSources(
  report: string,
  sources: readonly {
    id: string;
    url?: string;
    title?: string;
    documentId?: string;
  }[],
): string {
  const rows = sources.filter((s) =>
    /^https?:\/\//.test(s.url ?? s.documentId ?? ""),
  );
  if (!rows.length || report.includes("## 联网检索出处")) return report;
  return (
    report +
    "\n\n## 联网检索出处\n" +
    rows
      .map((s) => {
        const url = (s.url ?? s.documentId!).replace(/[<>\n\r]/g, "");
        return `- [${s.id}] ${s.title ?? url} — <${url}>`;
      })
      .join("\n")
  );
}

/** 降级检索时追加固定标题的检索说明；重复生成不叠加。 */
export function appendRetrievalNotice(
  report: string,
  degradedReason?: string,
): string {
  if (!degradedReason || report.includes("## 检索说明")) return report;
  return `${report}\n\n## 检索说明\n本轮仅使用稀疏检索（BM25），未使用向量检索。原因：${degradedReason}`;
}
