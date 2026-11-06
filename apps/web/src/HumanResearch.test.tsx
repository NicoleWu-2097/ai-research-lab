// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { HumanResearch } from "./HumanResearch";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});
const credential = { id: "task-1", key: "a".repeat(64) };
const task = {
  id: "task-1",
  question: "why",
  status: "pending",
  report: "",
  error: "",
  approval: {
    id: "approval-1",
    kind: "plan",
    question: "why",
    query: "original",
    questions: ["选型理由"],
    reason: "需要本地资料",
    expiresAt: new Date(Date.now() + 10000).toISOString(),
  },
  audit: [{ seq: 1, actor: "Alice", action: "created", created_at: "now" }],
};
it("restores a pending approval after refresh and submits an edited query with its version and key", async () => {
  localStorage.setItem("human-research", JSON.stringify(credential));
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    Response.json(init?.method === "POST" ? { ok: true } : task),
  );
  vi.stubGlobal("fetch", fetcher);
  render(<HumanResearch />);
  expect(await screen.findByText("需要本地资料")).toBeTruthy();
  await waitFor(() =>
    expect(
      (screen.getByLabelText("执行查询（可调整）") as HTMLTextAreaElement)
        .value,
    ).toBe("original"),
  );
  fireEvent.change(screen.getByLabelText("执行查询（可调整）"), {
    target: { value: "changed" },
  });
  fireEvent.click(screen.getByText("批准并继续"));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url, init]) =>
          String(url).endsWith("/approve") &&
          JSON.parse(String(init?.body)).value === "changed",
      ),
    ).toBe(true),
  );
  const post = fetcher.mock.calls.find(([url]) =>
    String(url).endsWith("/approve"),
  )!;
  expect(post[1]?.headers).toMatchObject({ "x-research-key": credential.key });
  expect(JSON.parse(String(post[1]?.body))).toMatchObject({
    approvalId: "approval-1",
    actor: "本机用户",
  });
});
it("can reject an approval and displays terminal state and audit", async () => {
  localStorage.setItem("human-research", JSON.stringify(credential));
  let rejected = false;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        rejected = true;
        return Response.json({ ok: true });
      }
      return Response.json(
        rejected ? { ...task, status: "rejected", approval: null } : task,
      );
    }),
  );
  render(<HumanResearch />);
  fireEvent.click(await screen.findByText("拒绝并结束"));
  expect(await screen.findByText("任务状态：rejected")).toBeTruthy();
  expect(screen.getByText(/Alice · created/)).toBeTruthy();
});
it("shows expired approvals without an approve action", async () => {
  localStorage.setItem("human-research", JSON.stringify(credential));
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ ...task, status: "expired" })),
  );
  render(<HumanResearch />);
  expect(await screen.findByText("任务状态：expired")).toBeTruthy();
  expect(screen.queryByText("批准并继续")).toBeNull();
});
