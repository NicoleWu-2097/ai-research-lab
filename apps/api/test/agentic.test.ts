import { expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "../src/model/types.js";
import { ModelError } from "../src/model/types.js";
import {
  runAgenticResearch,
  type LocalRetriever,
} from "../src/research/agentic.js";
import { McpDocumentTools, type ResearchTools } from "../src/mcp/client.js";
import { chunkDocument } from "../src/rag/chunks.js";
import { RagError } from "../src/rag/service.js";
import { createApp } from "../src/app.js";

const decision = (action: string, query = "") => ({
  action,
  query,
  reason: "简短的决策依据",
});
const document = (id: string) => ({
  id: `${id}.md`,
  content: `Evidence for ${id}`,
  sha256: "a".repeat(64),
  retrievedAt: new Date().toISOString(),
});
const hit = (id: string) => ({
  ...chunkDocument(document(id))[0]!,
  score: 0.9,
});
function provider(steps: unknown[], text = "有依据的回答 [RAG:1]") {
  const structuredOutput = vi.fn(async () => steps.shift());
  const stream = vi.fn(async function* () {
    yield text;
  });
  const model: ModelProvider = {
    provider: "ollama",
    model: "fake",
    async structuredOutput<T>() {
      return (await structuredOutput()) as T;
    },
    stream,
    async generate() {
      throw new Error("unused");
    },
  };
  return { model, stream, structuredOutput };
}
function run(
  model: ModelProvider,
  local: LocalRetriever | null = null,
  tools: ResearchTools | null = null,
  signal = new AbortController().signal,
) {
  const events: { type: string; [key: string]: unknown }[] = [];
  const deltas: string[] = [];
  const report = runAgenticResearch(
    "first",
    model,
    signal,
    async (text) => {
      deltas.push(text);
    },
    local,
    tools,
    async (type, payload) => {
      events.push({ type, ...payload });
    },
  );
  return { report, events, deltas };
}

it("answers directly without invoking available retrieval or MCP", async () => {
  const fake = provider([decision("direct")], "你好");
  const retrieve = vi.fn();
  const collect = vi.fn();
  const result = run(fake.model, { retrieve }, { collect });
  expect(await result.report).toContain("未检索外部资料");
  expect(retrieve).not.toHaveBeenCalled();
  expect(collect).not.toHaveBeenCalled();
  expect(fake.structuredOutput).toHaveBeenCalledTimes(1);
  expect(result.deltas.join("")).toBe(await result.report);
});

it("assesses local evidence before answering and exposes the route", async () => {
  const fake = provider([decision("local", "storage"), decision("sufficient")]);
  const retrieve = vi.fn().mockResolvedValue([hit("storage")]);
  const result = run(fake.model, { retrieve });
  expect(await result.report).toContain("[RAG:1]");
  expect(retrieve.mock.calls[0]?.[0]).toBe("first");
  expect(result.events.map((e) => e.type)).toEqual([
    "AGENT_DECISION",
    "RETRIEVAL_STARTED",
    "RETRIEVAL_COMPLETED",
    "EVIDENCE_ASSESSED",
    "RESEARCH_STOPPED",
    "SOURCES_COLLECTED",
    "CITATIONS_VALIDATED",
  ]);
});

it("rewrites the query once and preserves citation IDs across rounds", async () => {
  const fake = provider([
    decision("local", "first"),
    decision("local", "specific missing fact"),
    decision("sufficient"),
  ]);
  const retrieve = vi
    .fn()
    .mockResolvedValueOnce([hit("first")])
    .mockResolvedValueOnce([hit("first"), hit("second")]);
  const result = run(fake.model, { retrieve });
  await result.report;
  const snapshots = result.events.filter(
    (e) => e.type === "RETRIEVAL_COMPLETED",
  );
  expect(snapshots[0]?.sources).toMatchObject([
    { id: "RAG:1", chunkId: hit("first").id },
  ]);
  expect(snapshots[1]?.sources).toMatchObject([
    { id: "RAG:1", chunkId: hit("first").id },
    { id: "RAG:2", chunkId: hit("second").id },
  ]);
  expect(retrieve.mock.calls.map((call) => call[0])).toEqual([
    "first",
    "specific missing fact",
  ]);
});

it("enforces the local budget even when the model keeps asking for more", async () => {
  const fake = provider([
    decision("local", "one"),
    decision("local", "two"),
    decision("local", "three"),
  ]);
  const retrieve = vi
    .fn()
    .mockResolvedValueOnce([hit("one")])
    .mockResolvedValueOnce([hit("two")]);
  const result = run(fake.model, { retrieve });
  expect(await result.report).toContain("证据不足");
  expect(retrieve).toHaveBeenCalledTimes(2);
  expect(fake.stream).not.toHaveBeenCalled();
  expect(result.events.at(-1)).toMatchObject({
    reason: "unavailable_or_budget_exhausted",
  });
});

it("blocks normalized duplicate queries and stops when no new evidence is found", async () => {
  for (const query of ["  FIRST  ", "different query"]) {
    const fake = provider([
      decision("local", "first"),
      decision("local", query),
      decision("sufficient"),
    ]);
    const retrieve = vi.fn().mockResolvedValue([hit("same")]);
    const result = run(fake.model, { retrieve });
    expect(await result.report).toContain("证据不足");
    expect(result.events.at(-1)).toMatchObject({
      reason: query.trim() === "FIRST" ? "repeated_query" : "no_new_evidence",
    });
  }
});

it("allows a second search after zero hits but never accepts sufficient without evidence", async () => {
  const fake = provider([
    decision("local", "first"),
    decision("local", "second"),
    decision("sufficient"),
  ]);
  const retrieve = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([hit("second")]);
  expect(await run(fake.model, { retrieve }).report).toContain("[RAG:1]");
  const empty = provider([decision("local", "first"), decision("sufficient")]);
  const result = run(empty.model, { retrieve: async () => [] });
  expect(await result.report).toContain("证据不足");
  expect(result.events.at(-1)).toMatchObject({ reason: "no_evidence" });
});

it("refuses unavailable tools, illegal transitions and empty queries", async () => {
  for (const step of [
    decision("mcp", "x"),
    decision("sufficient"),
    decision("stop"),
  ]) {
    const fake = provider([step]);
    const result = run(fake.model, { retrieve: vi.fn() });
    expect(await result.report).toContain("证据不足");
    expect(fake.stream).not.toHaveBeenCalled();
  }
  const fake = provider([decision("local", "x"), decision("direct")]);
  const result = run(fake.model, { retrieve: async () => [hit("x")] });
  await result.report;
  expect(result.events.at(-1)).toMatchObject({ reason: "invalid_transition" });
  const empty = run(
    provider([decision("local", "x"), decision("local")]).model,
    { retrieve: async () => [hit("x")] },
  );
  await empty.report;
  expect(empty.events.at(-1)).toMatchObject({ reason: "empty_query" });
});

it("stops on retrieval failure without fabricating a model answer", async () => {
  const fake = provider([decision("local", "x")]);
  await expect(
    run(fake.model, {
      retrieve: async () => {
        throw new RagError();
      },
    }).report,
  ).rejects.toMatchObject({ code: "RAG_FAILED" });
  expect(fake.stream).not.toHaveBeenCalled();
});

it("checks the structured decision schema at the host boundary", async () => {
  const fake = provider([{ action: "shell", reason: "x", query: "rm" }]);
  await expect(run(fake.model).report).rejects.toMatchObject({
    code: "MODEL_INVALID_OUTPUT",
  });
});

it("cancels a stalled decision and sends timeout as a terminal SSE failure", async () => {
  const fake = provider([]);
  fake.model.structuredOutput = () => new Promise(() => undefined);
  const controller = new AbortController();
  const result = run(fake.model, null, null, controller.signal);
  controller.abort(new ModelError("MODEL_CANCELLED", "cancelled"));
  await expect(result.report).rejects.toMatchObject({
    code: "MODEL_CANCELLED",
  });
  const response = await createApp(fake.model, 10, null, null, true).request(
    "/api/research/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "question" }),
    },
  );
  const text = await response.text();
  expect(text).toContain("MODEL_TIMEOUT");
  expect(text).not.toContain("AGENT_COMPLETED");
});

it("uses a real MCP subprocess and maps its document chunks into citations", async () => {
  const root = await mkdtemp(join(tmpdir(), "m6-mcp-"));
  try {
    await writeFile(
      join(root, "storage.md"),
      "PostgreSQL keeps source evidence together.",
    );
    const fake = provider([
      decision("mcp", "storage"),
      { documentId: "storage.md" },
      decision("sufficient"),
    ]);
    const result = run(fake.model, null, new McpDocumentTools(root));
    expect(await result.report).toContain("[RAG:1]");
    expect(result.events.some((e) => e.type === "TOOLS_DISCOVERED")).toBe(true);
    expect(
      result.events.find((e) => e.type === "RETRIEVAL_COMPLETED")?.sources,
    ).toMatchObject([{ documentId: "storage.md", score: null, id: "RAG:1" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds the combined local and MCP workflow to three acquisitions", async () => {
  const fake = provider([
    decision("local", "one"),
    decision("mcp", "two"),
    decision("local", "three"),
    decision("mcp", "four"),
  ]);
  const retrieve = vi
    .fn()
    .mockResolvedValueOnce([hit("one")])
    .mockResolvedValueOnce([hit("three")]);
  const collect = vi.fn().mockResolvedValue([document("two")]);
  const result = run(fake.model, { retrieve }, { collect });
  expect(await result.report).toContain("证据不足");
  expect(retrieve).toHaveBeenCalledTimes(2);
  expect(collect).toHaveBeenCalledTimes(1);
  expect(fake.structuredOutput).toHaveBeenCalledTimes(4);
});
