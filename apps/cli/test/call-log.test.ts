import { expect, it } from "vitest";
import { renderCallLog } from "../src/call-log.js";
it("shows every call and duration, with recoverable long output", () => {
  const events = Array.from({ length: 12 }, (_, seq) => ({
    seq,
    action: "TOOL_COMPLETED",
    detail: { output: Array.from({ length: 10 }, (_, i) => `line ${i}`) },
  }));
  const compact = renderCallLog(events, false);
  expect(compact).toContain("#0");
  expect(compact).toContain("#11");
  expect(compact).toContain("\n\n•");
  expect(compact).toContain("lines (Ctrl+T");
  expect(renderCallLog(events, true)).toContain("line 9");
  expect(
    renderCallLog(
      [
        {
          seq: 1,
          action: "RETRIEVAL_STARTED",
          created_at: "2026-11-16T00:00:00Z",
        },
        {
          seq: 2,
          action: "RETRIEVAL_COMPLETED",
          created_at: "2026-11-16T00:00:01.373Z",
        },
      ],
      false,
    ),
  ).toContain("Time: 1.373s");
});
