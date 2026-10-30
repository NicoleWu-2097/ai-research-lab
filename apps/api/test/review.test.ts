import { expect, it, vi } from "vitest";
import {
  runReviewedResearch,
  type ResearchAgents,
} from "../src/research/review.js";
import { runAgenticResearch } from "../src/research/agentic.js";
import { createApp } from "../src/app.js";
import { ModelError, type ModelProvider } from "../src/model/types.js";
import { chunkDocument } from "../src/rag/chunks.js";

const source = {
  id: "RAG:1",
  content: "Storage is planned, not implemented.",
  sha256: "a".repeat(64),
  retrievedAt: new Date().toISOString(),
};
const input = { question: "存储是否实现？", sources: [source] };
const approved = {
  verdict: "approve" as const,
  issues: [],
  summary: "有证据支持",
};
const revise = {
  verdict: "revise" as const,
  issues: ["不要把规划写成已实现"],
  summary: "需要修订",
};
function setup(
  reviews: Awaited<ReturnType<ResearchAgents["critique"]>>[] = [approved],
) {
  const research = vi
    .fn<ResearchAgents["research"]>()
    .mockImplementation(async ({ revision }) =>
      revision ? "仅规划 [RAG:1]" : "已实现 [RAG:1]",
    );
  const critique = vi
    .fn<ResearchAgents["critique"]>()
    .mockImplementation(async () => reviews.shift()!);
  const events: { type: string; [key: string]: unknown }[] = [];
  const emit = async (type: string, payload: Record<string, unknown>) => {
    events.push({ type, ...payload });
  };
  return {
    research,
    critique,
    events,
    emit,
    run: (signal = new AbortController().signal) =>
      runReviewedResearch(input, { research, critique }, signal, emit),
  };
}

it("delegates evidence to distinct workers and publishes the approved draft", async () => {
  const test = setup();
  expect(await test.run()).toBe("已实现 [RAG:1]");
  expect(test.events.map((e) => e.type)).toEqual([
    "ROLE_DELEGATED",
    "DRAFT_READY",
    "ROLE_DELEGATED",
    "CRITIC_REVIEWED",
    "COORDINATOR_COMPLETED",
  ]);
  expect(test.critique.mock.calls[0]![0]).toEqual({
    ...input,
    draft: "已实现 [RAG:1]",
  });
  expect(test.events.at(-1)).toMatchObject({
    outcome: "approved",
    revisions: 0,
  });
});

it("returns concrete feedback and original evidence for one revision", async () => {
  const test = setup([revise, approved]);
  expect(await test.run()).toBe("仅规划 [RAG:1]");
  expect(test.research.mock.calls[1]![0]).toEqual({
    ...input,
    revision: { draft: "已实现 [RAG:1]", issues: revise.issues },
  });
  expect(test.events.at(-1)).toMatchObject({ revisions: 1 });
});

it("stops unresolved disagreement after two reviews without publishing drafts", async () => {
  const test = setup([revise, revise]);
  expect(await test.run()).toContain("审查未通过");
  expect(test.research).toHaveBeenCalledTimes(2);
  expect(test.critique).toHaveBeenCalledTimes(2);
  expect(test.events.at(-1)).toMatchObject({ outcome: "review_unresolved" });
  expect(JSON.stringify(test.events)).not.toContain("已实现 [RAG:1]");
});

it("isolates shared evidence from worker mutations", async () => {
  const test = setup();
  test.research.mockImplementationOnce(async (handoff) => {
    handoff.sources[0]!.content = "tampered";
    return "draft";
  });
  await test.run();
  expect(test.critique.mock.calls[0]![0].sources[0]!.content).toBe(
    source.content,
  );
});

it.each([
  { verdict: "approve", issues: ["conflict"], summary: "bad" },
  { verdict: "revise", issues: [], summary: "bad" },
  { verdict: "execute", issues: [], summary: "bad" },
])("rejects invalid review contracts %j", async (review) => {
  const test = setup();
  test.critique.mockResolvedValueOnce(review as never);
  await expect(test.run()).rejects.toMatchObject({
    code: "MODEL_INVALID_OUTPUT",
  });
  expect(test.events.some((e) => e.type === "COORDINATOR_COMPLETED")).toBe(
    false,
  );
});

it("fails closed on worker errors or empty drafts", async () => {
  for (const role of ["research", "critique"] as const) {
    const test = setup();
    test[role].mockRejectedValueOnce(
      new ModelError("MODEL_PROVIDER_ERROR", "unavailable"),
    );
    await expect(test.run()).rejects.toMatchObject({
      code: "MODEL_PROVIDER_ERROR",
    });
    expect(test.events.some((e) => e.type === "COORDINATOR_COMPLETED")).toBe(
      false,
    );
  }
  const test = setup();
  test.research.mockResolvedValueOnce(" ");
  await expect(test.run()).rejects.toMatchObject({
    code: "MODEL_INVALID_OUTPUT",
  });
});

it("cancels a stalled Critic without publishing", async () => {
  const test = setup();
  const controller = new AbortController();
  test.critique.mockImplementationOnce(async () => {
    controller.abort(new ModelError("MODEL_CANCELLED", "cancelled"));
    return new Promise(() => {});
  });
  await expect(test.run(controller.signal)).rejects.toMatchObject({
    code: "MODEL_CANCELLED",
  });
});

function model(steps: unknown[], reports = ["仅规划 [RAG:1]"]): ModelProvider {
  return {
    provider: "ollama",
    model: "fake",
    async structuredOutput<T>() {
      return steps.shift() as T;
    },
    async *stream() {
      yield reports.shift()!;
    },
    async generate() {
      throw new Error("unused");
    },
  };
}
const decision = (action: string) => ({
  action,
  query: "",
  reason: "简短依据",
});
const local = {
  async retrieve() {
    return [
      { ...chunkDocument({ ...source, id: "storage.md" })[0]!, score: 0.9 },
    ];
  },
};
it("integrates M6 with revision, withholding rejected draft deltas", async () => {
  const deltas: string[] = [];
  const events: string[] = [];
  const result = await runAgenticResearch(
    input.question,
    model(
      [decision("local"), decision("sufficient"), revise, approved],
      ["已实现 [RAG:1]", "仅规划 [RAG:1]"],
    ),
    new AbortController().signal,
    async (text) => {
      deltas.push(text);
    },
    local,
    null,
    async (type) => {
      events.push(type);
    },
    true,
  );
  expect(result).toBe("仅规划 [RAG:1]");
  expect(deltas).toEqual([result]);
  expect(events.filter((e) => e === "CRITIC_REVIEWED")).toHaveLength(2);
});

it("revalidates citations on revision before asking Critic again", async () => {
  await expect(
    runAgenticResearch(
      input.question,
      model(
        [decision("local"), decision("sufficient"), revise],
        ["已实现 [RAG:1]", "修订 [RAG:99]"],
      ),
      new AbortController().signal,
      async () => {},
      local,
      null,
      async () => {},
      true,
    ),
  ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
});

it("does not review direct answers or insufficient-evidence stops", async () => {
  for (const action of ["direct", "stop"]) {
    const events: string[] = [];
    await runAgenticResearch(
      "你好",
      model([decision(action)], ["你好"]),
      new AbortController().signal,
      async () => {},
      null,
      null,
      async (type) => {
        events.push(type);
      },
      true,
    );
    expect(events).not.toContain("ROLE_DELEGATED");
  }
});

it("exposes Critic timeout as SSE failure with no completed report", async () => {
  const provider = model([decision("mcp"), decision("sufficient")]);
  const original = provider.structuredOutput;
  let calls = 0;
  provider.structuredOutput = async (...args) =>
    ++calls > 2 ? new Promise(() => {}) : original(...args);
  const tools = {
    async collect() {
      return [{ ...source, id: "storage.md" }];
    },
  };
  const app = createApp(provider, 100, tools, null, true, true);
  const response = await app.request("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: input.question }),
  });
  const body = await response.text();
  expect(body).toContain("MODEL_TIMEOUT");
  expect(body).not.toContain('"type":"AGENT_COMPLETED"');
  expect(body).not.toContain('"type":"REPORT_DELTA"');
});
