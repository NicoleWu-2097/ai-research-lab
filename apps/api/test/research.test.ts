import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { ModelError, type ModelProvider } from "../src/model/types.js";
import { runResearch } from "../src/research/workflow.js";

function fake(stream: ModelProvider["stream"]): ModelProvider {
  return {
    provider: "ollama",
    model: "fake",
    stream,
    async generate() {
      throw new Error("unused");
    },
    async structuredOutput() {
      throw new Error("unused");
    },
  };
}
const post = (provider: ModelProvider | null, timeout = 1000) =>
  createApp(provider, timeout).request("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Compare two designs" }),
  });

describe("Research Agent", () => {
  it("runs the graph and emits ordered task events with a completed report", async () => {
    const response = await post(
      fake(async function* (prompt) {
        expect(prompt).toContain("Do not invent citations");
        expect(prompt).toContain("Compare two designs");
        yield "First ";
        yield "analysis";
      }),
    );
    const frames = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "));
    const events = frames.map(
      (frame) =>
        JSON.parse(frame.slice(6)) as {
          type: string;
          sequence: number;
          taskId: string;
          report?: string;
        },
    );
    expect(events.map((event) => event.type)).toEqual([
      "TASK_CREATED",
      "AGENT_STARTED",
      "REPORT_DELTA",
      "REPORT_DELTA",
      "AGENT_COMPLETED",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(events.map((event) => event.taskId)).size).toBe(1);
    expect(events.at(-1)?.report).toBe("First analysis");
  });

  it("emits failure, never completion, after a provider error", async () => {
    const response = await post(
      fake(async function* () {
        yield "partial";
        throw new Error("private detail");
      }),
    );
    const text = await response.text();
    expect(text).toContain("AGENT_FAILED");
    expect(text).not.toContain("AGENT_COMPLETED");
    expect(text).not.toContain("private detail");
  });

  it("times out a stalled model", async () => {
    const response = await post(
      fake(async function* () {
        await new Promise(() => undefined);
        yield "never";
      }),
      10,
    );
    expect(await response.text()).toContain("MODEL_TIMEOUT");
  });

  it("cancels execution through its signal", async () => {
    const controller = new AbortController();
    const run = runResearch(
      "question",
      fake(async function* () {
        await new Promise(() => undefined);
        yield "never";
      }),
      controller.signal,
      async () => undefined,
    );
    controller.abort(new ModelError("MODEL_CANCELLED", "cancelled"));
    await expect(run).rejects.toMatchObject({ code: "MODEL_CANCELLED" });
  });

  it("rejects unconfigured requests before opening SSE", async () => {
    expect((await post(null)).status).toBe(503);
  });
});
