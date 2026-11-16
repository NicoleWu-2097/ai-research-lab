import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
export interface ReportTask {
  id: string;
  status: string;
  report: string;
  history?: { report: string }[];
}
export async function saveReport(
  task: ReportTask,
  directory = "",
  cwd = process.env.INIT_CWD ?? process.cwd(),
) {
  const terminal = [
    "completed",
    "failed",
    "interrupted",
    "rejected",
    "expired",
  ].includes(task.status);
  const report =
    (terminal && task.report.trim()
      ? task.report
      : [...(task.history ?? [])].reverse().find((turn) => turn.report.trim())
          ?.report) ?? "";
  if (!report) throw new Error("尚无可保存的报告；当前流式草稿完成后再保存。");
  const target = directory
    .trim()
    .replace(/^(["'])(.*)\1$/, "$2")
    .replace(/^~(?=\/|$)/, homedir());
  const folder = resolve(cwd, target || ".");
  await mkdir(folder, { recursive: true });
  const path = join(
    folder,
    `report-${task.id.replace(/[^a-zA-Z0-9-]/g, "")}-${randomUUID()}.md`,
  );
  await writeFile(path, report, { encoding: "utf8", flag: "wx" });
  return path;
}
