import { createApp } from "../src/app.js";
import type { ModelProvider } from "../src/model/types.js";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { TaskState } from "@a2a-js/sdk";
import { createRemoteAgents, readAgentEndpoints } from "../src/a2a/client.js";
import { createDeadline } from "../src/model/deadline.js";
import { runReviewedResearch } from "../src/research/review.js";

const children: ChildProcess[] = [];
let researcher: string;
let critic: string;
async function start(role: string): Promise<string> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "test/fixtures/a2a-worker.ts", role],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error("Worker startup timeout")),
      10000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Worker exited ${code}`));
    });
    child.stdout!.on("data", (chunk) => {
      text += String(chunk);
      if (text.includes("\n")) {
        clearTimeout(timer);
        resolve(
          (JSON.parse(text.split("\n")[0]!) as { endpoint: string }).endpoint,
        );
      }
    });
  });
}
beforeAll(async () => {
  researcher = await start("researcher");
  critic = await start("critic");
});
afterAll(async () => {
  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await once(child, "exit");
      }
    }),
  );
});
const input = {
  question: "why",
  sources: [
    {
      id: "RAG:1",
      content: "记录设计决策，未证明实现。",
      sha256: "a".repeat(64),
      retrievedAt: new Date().toISOString(),
    },
  ],
};
const signal = () => AbortSignal.timeout(8000);
function fixture(fetchImpl?: typeof fetch) {
  const events: { type: string; [key: string]: unknown }[] = [];
  const emit = async (type: string, payload: Record<string, unknown>) => {
    events.push({ type, ...payload });
  };
  return {
    events,
    emit,
    agents: createRemoteAgents({ researcher, critic }, emit, fetchImpl),
  };
}
it("discovers two independent official SDK services and delegates the complete review", async () => {
  const test = fixture();
  expect(
    await runReviewedResearch(input, test.agents, signal(), test.emit),
  ).toBe("仅记录设计决策 [RAG:1]");
  expect(
    test.events.filter((e) => e.type === "A2A_DISCOVERED").map((e) => e.agent),
  ).toEqual(["researcher", "critic"]);
  expect(test.events.filter((e) => e.type === "A2A_ARTIFACT")).toHaveLength(2);
  expect(test.events.filter((e) => e.type === "A2A_COMPLETED")).toHaveLength(2);
  const client = await new ClientFactory().createFromUrl(researcher);
  const taskId = test.events.find((e) => e.type === "A2A_TASK_CREATED")!
    .remoteTaskId as string;
  const task = await client.getTask({
    id: taskId,
    tenant: "",
    historyLength: 1,
  });
  expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  expect(task.history).toHaveLength(1);
  expect(task.artifacts[0]?.parts[0]?.content?.$case).toBe("data");
  expect(children[0]!.pid).not.toBe(children[1]!.pid);
});
it("fails closed on remote execution errors, timeout and invalid artifacts", async () => {
  for (const question of ["fail", "timeout", "bad-citation"]) {
    const test = fixture();
    await expect(
      test.agents.research({ ...input, question, revision: null }, signal()),
    ).rejects.toMatchObject({ code: "A2A_FAILED" });
  }
  const test = fixture();
  await expect(
    test.agents.critique(
      { ...input, question: "bad-review", draft: "draft" },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "A2A_FAILED" });
});
it("propagates coordinator cancellation to the remote task", async () => {
  const controller = new AbortController();
  const events: { type: string; remoteTaskId?: unknown }[] = [];
  const agents = createRemoteAgents(
    { researcher, critic },
    async (type, payload) => {
      events.push({ type, ...payload });
      if (type === "A2A_PROGRESS") controller.abort(new Error("cancel"));
    },
  );
  await expect(
    agents.research(
      { ...input, question: "slow", revision: null },
      controller.signal,
    ),
  ).rejects.toThrow("cancel");
  const client = await new ClientFactory().createFromUrl(researcher);
  const id = events.find((e) => e.type === "A2A_TASK_CREATED")!
    .remoteTaskId as string;
  expect((await client.getTask({ id, tenant: "" })).status?.state).toBe(
    TaskState.TASK_STATE_CANCELED,
  );
});
it("cancels remote work when the coordinator deadline expires", async () => {
  const test = fixture();
  const deadline = createDeadline(new AbortController().signal, 120);
  try {
    await expect(
      test.agents.research(
        { ...input, question: "slow", revision: null },
        deadline.signal,
      ),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
  } finally {
    deadline.dispose();
  }
  const id = test.events.find((e) => e.type === "A2A_TASK_CREATED")!
    .remoteTaskId as string;
  const client = await new ClientFactory().createFromUrl(researcher);
  expect((await client.getTask({ id, tenant: "" })).status?.state).toBe(
    TaskState.TASK_STATE_CANCELED,
  );
});
it("retries discovery and recovers a broken stream without duplicate execution", async () => {
  let discoveries = 0;
  let sends = 0;
  const before = (await (await fetch(`${researcher}/test/calls`)).json()) as {
    calls: number;
  };
  const flaky: typeof fetch = async (url, init) => {
    if (String(url).includes("agent-card") && ++discoveries === 1)
      throw new TypeError("network down");
    const response = await fetch(url, init);
    if (
      typeof init?.body === "string" &&
      init.body.includes('"SendStreamingMessage"')
    ) {
      sends++;
      const reader = response.body!.getReader();
      let first = true;
      return new Response(
        new ReadableStream({
          async pull(controller) {
            if (first) {
              first = false;
              const chunk = await reader.read();
              controller.enqueue(chunk.value!);
            } else {
              await delay(20);
              controller.error(new TypeError("connection dropped"));
              await reader.cancel();
            }
          },
        }),
        { headers: response.headers },
      );
    }
    return response;
  };
  const test = fixture(flaky);
  expect(
    await test.agents.research(
      { ...input, question: "slow", revision: null },
      signal(),
    ),
  ).toContain("[RAG:1]");
  expect(sends).toBe(1);
  const after = (await (await fetch(`${researcher}/test/calls`)).json()) as {
    calls: number;
  };
  expect(after.calls - before.calls).toBe(1);
  expect(
    test.events.filter((e) => e.type === "A2A_RETRY").length,
  ).toBeGreaterThanOrEqual(2);
});
it("rejects untrusted endpoints, cards and invalid role inputs", async () => {
  expect(() =>
    readAgentEndpoints({
      A2A_ENABLED: "true",
      A2A_RESEARCHER_URL: "https://example.com",
    }),
  ).toThrow();
  expect(() =>
    readAgentEndpoints({ A2A_ENABLED: "true", MULTI_AGENT_ENABLED: "false" }),
  ).toThrow();
  const card = await new DefaultAgentCardResolver().resolve(researcher);
  const badFetch: typeof fetch = async () =>
    Response.json({
      ...card,
      supportedInterfaces: [
        {
          url: "http://example.com/a2a",
          protocolVersion: "1.0",
          protocolBinding: "JSONRPC",
        },
      ],
    });
  await expect(
    fixture(badFetch).agents.research({ ...input, revision: null }, signal()),
  ).rejects.toMatchObject({ code: "A2A_FAILED" });
  await expect(
    fixture().agents.research(
      { ...input, sources: [], revision: null },
      signal(),
    ),
  ).rejects.toMatchObject({ code: "A2A_FAILED" });
  expect(
    (
      await fetch(`${researcher}/.well-known/agent-card.json`, {
        headers: { Origin: "https://example.com" },
      })
    ).status,
  ).toBe(403);
});

it("does not replay an ambiguous message submission", async () => {
  let sends = 0;
  const flaky: typeof fetch = async (url, init) => {
    if (
      typeof init?.body === "string" &&
      init.body.includes('"SendStreamingMessage"')
    ) {
      sends++;
      throw new TypeError("unknown delivery");
    }
    return fetch(url, init);
  };
  await expect(
    fixture(flaky).agents.research({ ...input, revision: null }, signal()),
  ).rejects.toMatchObject({ code: "A2A_FAILED" });
  expect(sends).toBe(1);
});
it("wires the HTTP Coordinator to remote roles and propagates transport failures", async () => {
  function model(): ModelProvider {
    let calls = 0;
    return {
      provider: "ollama",
      model: "route-only",
      async structuredOutput<T>() {
        return {
          action: ++calls === 1 ? "mcp" : "sufficient",
          query: "",
          reason: "需要证据",
        } as T;
      },
      async generate() {
        throw new Error("local generation forbidden");
      },
      async *stream() {
        yield await Promise.reject(new Error("local generation forbidden"));
      },
    };
  }
  const tools = {
    async collect() {
      return [{ ...input.sources[0]!, id: "source.md" }];
    },
  };
  for (const [endpoint, success] of [
    [researcher, true],
    [critic, false],
  ] as const) {
    const app = createApp(model(), 5000, tools, null, true, true, {
      researcher: endpoint,
      critic,
    });
    const response = await app.request("/api/research/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "why" }),
    });
    const body = await response.text();
    expect(body.includes('"type":"AGENT_COMPLETED"')).toBe(success);
    if (success) expect(body).toContain('"type":"A2A_COMPLETED"');
    else {
      expect(body).toContain('"code":"A2A_FAILED"');
      expect(body).not.toContain('"type":"REPORT_DELTA"');
    }
  }
});
it("runs the M9 analysis and Critic path through the two real role processes", async () => {
  let calls = 0;
  const model: ModelProvider = {
    provider: "ollama",
    model: "loop-coordinator",
    async structuredOutput<T>() {
      return (
        ++calls === 1
          ? {
              action: "mcp",
              questions: ["设计是否落地？"],
              query: "设计是否落地",
              reason: "需要证据",
            }
          : {
              findings: [
                {
                  kind: "observation",
                  text: "资料仅记录设计。",
                  evidence: [{ sourceId: "RAG:1", quote: "记录设计决策" }],
                },
              ],
              unresolved: [],
            }
      ) as T;
    },
    async generate() {
      throw new Error("local generation forbidden");
    },
    async *stream() {
      yield await Promise.reject(new Error("local generation forbidden"));
    },
  };
  const tools = {
    async collect() {
      return [{ ...input.sources[0]!, id: "source.md" }];
    },
  };
  const app = createApp(
    model,
    5000,
    tools,
    null,
    true,
    true,
    { researcher, critic },
    true,
  );
  const response = await app.request("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "why" }),
  });
  const body = await response.text();
  expect(body).toContain('"type":"LOOP_COMPLETED"');
  expect(body).toContain('"outcome":"approved"');
  expect(body).toContain('"calls":4');
  expect(body).toContain('"type":"AGENT_COMPLETED"');
});
