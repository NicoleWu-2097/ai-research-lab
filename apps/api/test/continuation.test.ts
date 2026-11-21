import { expect, it } from "vitest";
import { nextEvidence } from "../src/human/continuation.js";
it("extracts the next evidence section and its subheadings without later sections", () => {
  expect(
    nextEvidence(
      "# 报告\n## 下一步所需证据\n- 性能实测\n### 来源\n- 论文\n## 结论\n不应提取",
    ),
  ).toBe("- 性能实测\n### 来源\n- 论文");
  expect(
    nextEvidence("**下一步所需证据**：对照实验\n\n## 来源\n不要提取"),
  ).toBe("对照实验");
  expect(nextEvidence("## 尚缺材料与下一步\n- 同步成本")).toBe("- 同步成本");
  expect(nextEvidence("## 下一步所需证据\n\n## 来源\n完成")).toBe("");
  expect(nextEvidence("没有缺口")).toBe("");
});
