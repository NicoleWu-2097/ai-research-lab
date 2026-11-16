export interface CallEvent {
  seq: string | number;
  action: string;
  created_at?: string;
  detail?: Record<string, unknown>;
}
/** 每个事件有独立标题；仅长输出折叠，并明确标出未显示行数。 */
export function renderCallLog(
  events: readonly CallEvent[],
  expanded: boolean,
): string {
  const lines: string[] = [];
  const starts = new Map<string, number>();
  let previews = 0;
  let internal = 0;
  for (const event of events) {
    if (event.action === "REPORT_PREVIEW") {
      previews++;
      continue;
    }
    if (
      !expanded &&
      /^(node_|intent_|transform_|LOOP_|ROLE_|CITATIONS_|created$|started$|approved$|completed$)/.test(
        event.action,
      )
    ) {
      internal++;
      continue;
    }
    if (
      !expanded &&
      /_STARTED$/.test(event.action) &&
      events.some(
        (later) =>
          Number(later.seq) > Number(event.seq) &&
          later.action === event.action.replace(/_STARTED$/, "_COMPLETED"),
      )
    ) {
      const key = String(
        event.detail?.node ??
          event.detail?.tool ??
          event.action.replace(/_(STARTED|COMPLETED)$/, ""),
      );
      if (event.created_at) starts.set(key, Date.parse(event.created_at));
      continue;
    }
    const detail = event.detail ?? {};
    const key = String(
      detail.node ??
        detail.tool ??
        event.action.replace(/_(STARTED|COMPLETED)$/, ""),
    );
    const at = event.created_at ? Date.parse(event.created_at) : NaN;
    const starting = /started$/i.test(event.action);
    if (starting && Number.isFinite(at)) starts.set(key, at);
    const start = starts.get(key);
    const finished = /completed$/i.test(event.action);
    const duration =
      finished && start !== undefined && Number.isFinite(at)
        ? `\n  └ Time: ${Math.max(0, (at - start) / 1000).toFixed(3)}s`
        : "";
    if (finished) starts.delete(key);
    const label =
      event.action === "RETRIEVAL_STARTED"
        ? `Running ${detail.action ?? "search"}`
        : event.action === "RETRIEVAL_COMPLETED"
          ? `Ran ${detail.action ?? "search"}`
          : event.action;
    if (lines.length) lines.push("");
    lines.push(
      `• ${label} #${event.seq}${detail.query ? ` · ${detail.query}` : ""}${duration}`,
    );
    const output = Object.fromEntries(
      Object.entries(detail).filter(([key]) => key !== "_event"),
    );
    const rows = Object.keys(output).length
      ? JSON.stringify(output, null, 2).split("\n")
      : [];
    if (!expanded) {
      if (Array.isArray(detail.sources))
        lines.push(`  └ 命中 ${detail.sources.length} 条资料`);
      else if (typeof detail.message === "string")
        lines.push(`  └ ${detail.message.split("\n")[0]}`);
    }
    const shown = expanded ? rows : [];
    lines.push(...shown.map((row) => "  " + row));
    if (shown.length < rows.length)
      lines.push(
        `  + ${rows.length - shown.length} lines (Ctrl+T 或 /tools 展开完整输出)`,
      );
  }
  if (internal)
    lines.push(`  + ${internal} 条执行状态记录（Ctrl+T 或 /tools 查看）`);
  if (previews)
    lines.push(`• 报告流：${previews} 次增量更新已合并，完整报告见正文`);
  return lines.join("\n");
}
