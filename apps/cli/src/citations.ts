/**
 * 引用与证据卡的纯文本构造。
 *
 * CLI 是终端界面：内容区只是可滚动的文本流，没有 DOM 可以挂点击。
 * 所以“点开引用”在终端里的等价物是 `/cite <编号>`：
 * 报告里保留 [RAG:n] 标记，输入编号后把证据卡追加到内容区。
 * 这里只做字符串组装，方便单测，也方便和 Ink 渲染解耦。
 */

export type SourceLike = {
  id: string;
  documentId?: string;
  title?: string;
  url?: string;
  startLine?: number;
  endLine?: number;
  score?: number | null;
  content?: string;
  sha256?: string;
  retrievedAt?: string;
};

export type FindingLike = {
  kind: string;
  text: string;
  evidence?: { sourceId: string; quote: string }[];
};

const KIND_LABEL: Record<string, string> = {
  observation: "观察",
  inference: "推断",
};

/** RAG:3 → 3；没有编号时退回数组下标。 */
export function citationNumber(source: SourceLike, index: number): number {
  const match = /^RAG:(\d+)$/.exec(source.id ?? "");
  return match ? Number(match[1]) : index + 1;
}

/** 报告里出现的引用标记；不是 RAG 编号时退回 [下标]。 */
function citationLabel(source: SourceLike, index: number): string {
  return /^RAG:\d+$/.test(source.id ?? "")
    ? `[${source.id}]`
    : `[${index + 1}]`;
}

function sourceName(source: SourceLike): string {
  return source.title ?? source.documentId ?? source.id;
}

function sourceLocation(source: SourceLike): string {
  const parts: string[] = [];
  if (source.startLine !== undefined && source.endLine !== undefined)
    parts.push(`L${source.startLine}–${source.endLine}`);
  if (typeof source.score === "number") parts.push(source.score.toFixed(2));
  if (source.url) parts.push("网页摘要");
  else if (parts.length === 0) parts.push("本地片段");
  return parts.join(" · ");
}

/** 报告末尾的来源索引：每份来源一行，足够判断“这份值不值得点开”。 */
export function buildSourcesIndex(sources: SourceLike[]): string {
  if (sources.length === 0) return "";
  const rows = sources.map(
    (source, index) =>
      `  ${citationLabel(source, index)} ${sourceName(source)} · ${sourceLocation(source)}`,
  );
  return [
    `来源（${sources.length} 份 · /cite <编号> 查看证据卡，例如 /cite ${citationNumber(sources[0]!, 0)}；加 full 看原文全文）`,
    ...rows,
  ].join("\n");
}

/**
 * 把原文归一化成「只保留字词」的串，并记录每个字在原串里的位置。
 * 归一化同时丢掉 Markdown 链接地址、空白与标点，因为模型抄原文时常改写这些。
 */
function flattenWithMap(content: string): {
  text: string;
  positions: number[];
} {
  let text = "";
  const positions: number[] = [];
  let index = 0;
  while (index < content.length) {
    const char = content[index]!;
    // 跳过 Markdown 链接的「](url)」部分，只保留前面的显示文字。
    if (char === "]" && content[index + 1] === "(") {
      let cursor = index + 2;
      while (cursor < content.length && content[cursor] !== ")") cursor += 1;
      index = cursor + 1;
      continue;
    }
    if (/[\s"'“”‘’、，。；：！？·,.!?;:()［］【】[\]]/.test(char)) {
      index += 1;
      continue;
    }
    text += char.toLowerCase();
    positions.push(index);
    index += 1;
  }
  return { text, positions };
}

function flattenText(value: string): string {
  return flattenWithMap(value).text;
}

/** 在原文里定位引文；精确匹配优先，失败时按归一化后的字序定位。 */
export function locateQuote(content: string, quote: string): number {
  const exact = content.indexOf(quote);
  if (exact >= 0) return exact;
  const { text, positions } = flattenWithMap(content);
  const target = flattenText(quote);
  if (target.length < 4) return -1;
  const at = text.indexOf(target);
  if (at < 0) return -1;
  return positions[at] ?? 0;
}

const WINDOW_RADIUS = 200;

/** 以引文为中心截取上下文；前后被省略时补 … 标记，命中处用 «» 括起来。 */
export function quoteWindow(
  content: string,
  quote: string,
  radius = WINDOW_RADIUS,
): string {
  const at = locateQuote(content, quote);
  if (at < 0) return content.slice(0, radius * 2);
  const start = Math.max(0, at - radius);
  const end = Math.min(content.length, at + quote.length + radius);
  const head = start > 0 ? "…" : "";
  const tail = end < content.length ? "…" : "";
  if (at >= start && at + quote.length <= end) {
    const before = content.slice(start, at);
    const hit = content.slice(at, at + quote.length);
    const after = content.slice(at + quote.length, end);
    return `${head}${before}«${hit}»${after}${tail}`;
  }
  return `${head}${content.slice(start, end)}${tail}`;
}

function quotesFor(findings: FindingLike[], sourceId: string): string[] {
  const quotes: string[] = [];
  for (const finding of findings)
    for (const evidence of finding.evidence ?? [])
      if (evidence.sourceId === sourceId && evidence.quote)
        quotes.push(evidence.quote);
  return quotes;
}

/** 证据卡：身份 / 支撑了哪些结论 / 原文窗口 / 定位信息。 */
export function buildEvidenceCard(
  source: SourceLike,
  findings: FindingLike[],
  options: { index: number; full?: boolean; unverifiedText?: string },
): string {
  const number = citationNumber(source, options.index);
  const content = (source.content ?? "").replace(/\r\n/g, "\n");
  const supported = findings.filter((finding) =>
    (finding.evidence ?? []).some((e) => e.sourceId === source.id),
  );
  const lines: string[] = [];
  lines.push(
    `证据卡 ${citationLabel(source, options.index)} ${sourceName(source)}`,
  );

  const meta = [sourceLocation(source)];
  if (source.retrievedAt)
    meta.push(`取回 ${new Date(source.retrievedAt).toLocaleTimeString()}`);
  lines.push(`  位置  ${meta.filter(Boolean).join(" · ")}`);
  lines.push(
    `  类型  ${source.url ? "网页摘要（非网页全文）" : "本地文档"}${
      source.sha256 ? ` · sha256 ${source.sha256.slice(0, 12)}…` : ""
    }`,
  );

  lines.push(`  ── 支撑的结论（${supported.length} 条）`);
  if (supported.length === 0)
    lines.push(
      `    ${options.unverifiedText ?? "本轮未生成结构化证据，仅有片段原文。"}`,
    );
  else
    for (const finding of supported)
      lines.push(
        `    ${KIND_LABEL[finding.kind] ?? finding.kind} · ${finding.text.slice(0, 56)}${finding.text.length > 56 ? "…" : ""}`,
      );

  const quotes = quotesFor(findings, source.id);
  lines.push("  ── 原文（«» 之间是被引用的片段）");
  if (options.full || quotes.length === 0) {
    const body = options.full ? content : content.slice(0, 300);
    for (const line of body.split("\n")) lines.push(`    ${line}`);
    if (!options.full && content.length > 300)
      lines.push(
        `    …（其余 ${content.length - 300} 字未显示，/cite ${number} full 查看全文）`,
      );
  } else {
    const window = quoteWindow(content, quotes[0]!);
    for (const line of window.split("\n")) lines.push(`    ${line}`);
    if (window.length < content.length)
      lines.push(
        `    …（片段共 ${content.length} 字，/cite ${number} full 查看全文）`,
      );
  }
  return lines.join("\n");
}

/** 报告 + 来源索引，作为一条消息推入内容区。 */
export function buildReportBlock(
  report: string,
  sources: SourceLike[],
): string {
  const index = buildSourcesIndex(sources);
  return index ? `${report}\n\n${index}` : report;
}
