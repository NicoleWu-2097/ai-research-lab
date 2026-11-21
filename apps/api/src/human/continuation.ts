/** Extract the evidence request, not instructions embedded elsewhere in a report. */
export function nextEvidence(report: string): string {
  const lines = report.split(/\r?\n/);
  let start = -1;
  let depth = 6;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (
      /下一步所需证据|尚缺材料与下一步|next\s+(?:required\s+)?evidence/i.test(
        line,
      )
    ) {
      start = i;
      depth = line.match(/^\s*(#{1,6})\s/)?.[1]?.length ?? 6;
      break;
    }
  }
  if (start < 0) return "";
  const inline = lines[start]!.replace(
    /^.*?(?:下一步所需证据|尚缺材料与下一步|next\s+(?:required\s+)?evidence)\s*[*：:]*/i,
    "",
  ).trim();
  const result = inline ? [inline] : [];
  for (const line of lines.slice(start + 1)) {
    const heading = line.match(/^\s*(#{1,6})\s/);
    if (heading && heading[1]!.length <= depth) break;
    result.push(line);
  }
  return result.join("\n").trim().slice(0, 4000);
}
