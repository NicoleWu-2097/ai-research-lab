import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveReport } from "../src/save-report.js";
it("saves complete Markdown including sources, supports spaced directories and never overwrites", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "report-export-"));
  try {
    const report = "# 研究结果\n\n[出处](https://example.com)\n";
    const task = { id: "project", status: "completed", report };
    const first = await saveReport(task, "", cwd);
    const second = await saveReport(task, "", cwd);
    expect(first).not.toBe(second);
    expect(await readFile(first, "utf8")).toBe(report);
    const nested = await saveReport(task, '"my reports"', cwd);
    expect(nested.startsWith(join(cwd, "my reports"))).toBe(true);
    expect(await readFile(nested, "utf8")).toBe(report);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
it("uses the last finished report while generating and rejects when no report exists", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "report-export-"));
  try {
    const task = {
      id: "project",
      status: "running",
      report: "PARTIAL",
      history: [{ report: "OLD" }, { report: "LATEST" }],
    };
    const path = await saveReport(task, "", cwd);
    expect(await readFile(path, "utf8")).toBe("LATEST");
    await expect(saveReport({ ...task, history: [] }, "", cwd)).rejects.toThrow(
      "尚无可保存",
    );
    expect(await readdir(cwd)).toHaveLength(1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
