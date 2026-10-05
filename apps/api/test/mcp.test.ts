import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import {
  createDocumentTransport,
  McpDocumentTools,
} from "../src/mcp/client.js";
import type { ModelProvider } from "../src/model/types.js";
import { runResearch } from "../src/research/workflow.js";

let directory: string;
let root: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "research-mcp-"));
  root = join(directory, "notes");
  await mkdir(root);
  await writeFile(
    join(root, "storage.md"),
    "# Storage\nPostgreSQL keeps task records and vectors together.",
  );
  await writeFile(join(directory, "secret.md"), "private sentinel");
  await symlink(join(directory, "secret.md"), join(root, "linked.md"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("real MCP stdio integration", () => {
  it("discovers tools, lists and reads only allowed documents", async () => {
    const client = new Client({ name: "test", version: "1" });
    const transport = createDocumentTransport(root);
    transport.stderr?.on("data", () => undefined);
    try {
      await client.connect(transport, { timeout: 3000 });
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        "list_documents",
        "read_document",
      ]);
      const list = await client.callTool({
        name: "list_documents",
        arguments: {},
      });
      expect(JSON.stringify(list)).toContain("storage.md");
      expect(JSON.stringify(list)).not.toContain("linked.md");
      const read = await client.callTool({
        name: "read_document",
        arguments: { id: "storage.md" },
      });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).toContain("PostgreSQL");
      const link = await client.callTool({
        name: "read_document",
        arguments: { id: "linked.md" },
      });
      expect(link.isError).toBe(true);
      expect(JSON.stringify(link)).not.toContain("private sentinel");
      await writeFile(join(root, "large.md"), "x".repeat(24_001));
      expect(
        (
          await client.callTool({
            name: "read_document",
            arguments: { id: "large.md" },
          })
        ).isError,
      ).toBe(true);
      const traversal = await client
        .callTool({ name: "read_document", arguments: { id: "../secret.md" } })
        .catch(() => ({ isError: true }));
      expect(traversal.isError).toBe(true);
      expect(JSON.stringify(traversal)).not.toContain("private sentinel");
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("runs discovery and model-selected reading before report generation", async () => {
    const provider: ModelProvider = {
      provider: "ollama",
      model: "fake",
      async generate() {
        throw new Error("unused");
      },
      async structuredOutput(prompt, schema) {
        expect(prompt).toContain("storage.md");
        return schema.parse({ documentId: "storage.md" });
      },
      async *stream(prompt) {
        expect(prompt).toContain("PostgreSQL keeps task records");
        expect(prompt).toContain("untrusted evidence");
        yield "Use PostgreSQL [storage.md]";
      },
    };
    const events: string[] = [];
    const report = await runResearch(
      "Which storage?",
      provider,
      AbortSignal.timeout(5000),
      async () => undefined,
      new McpDocumentTools(root),
      async (type) => {
        events.push(type);
      },
    );
    expect(report).toContain("[storage.md]");
    expect(events).toEqual([
      "TOOLS_DISCOVERED",
      "TOOL_CALLED",
      "TOOL_RESULT",
      "TOOL_CALLED",
      "TOOL_RESULT",
      "SOURCES_COLLECTED",
    ]);
  });

  it("skips reading when the model selects none", async () => {
    const provider: ModelProvider = {
      provider: "ollama",
      model: "fake",
      async generate() {
        throw new Error("unused");
      },
      async structuredOutput(_prompt, schema) {
        return schema.parse({ documentId: "none" });
      },
      async *stream() {
        yield "unused";
      },
    };
    const calls: string[] = [];
    const result = await new McpDocumentTools(root).collect(
      "Unrelated question",
      provider,
      AbortSignal.timeout(5000),
      async (type) => {
        calls.push(type);
      },
    );
    expect(result).toEqual([]);
    expect(calls).toContain("TOOL_SKIPPED");
    expect(calls.filter((type) => type === "TOOL_CALLED")).toHaveLength(1);
  });

  it("fails explicitly for an unavailable directory", async () => {
    const events: string[] = [];
    const provider: ModelProvider = {
      provider: "ollama",
      model: "fake",
      async generate() {
        throw new Error("unused");
      },
      async structuredOutput() {
        throw new Error("must not reach model selection");
      },
      async *stream() {
        yield "unused";
      },
    };
    await expect(
      new McpDocumentTools(join(root, "missing")).collect(
        "question",
        provider,
        AbortSignal.timeout(5000),
        async (type) => {
          events.push(type);
        },
      ),
    ).rejects.toMatchObject({ code: "MCP_TOOL_FAILED" });
    expect(events).toContain("TOOL_FAILED");
  });

  it("cancels during model selection and closes its MCP session", async () => {
    const controller = new AbortController();
    const provider: ModelProvider = {
      provider: "ollama",
      model: "fake",
      async generate() {
        throw new Error("unused");
      },
      async structuredOutput() {
        controller.abort(new Error("cancelled during selection"));
        return new Promise(() => undefined);
      },
      async *stream() {
        yield "unused";
      },
    };
    await expect(
      new McpDocumentTools(root).collect(
        "question",
        provider,
        controller.signal,
        async () => undefined,
      ),
    ).rejects.toThrow("cancelled during selection");
  });
});
