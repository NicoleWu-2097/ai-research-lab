import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { documentIdSchema, listDocuments, readDocument } from "./documents.js";

const root = process.env.MCP_DOCUMENT_ROOT;
if (!root) throw new Error("MCP_DOCUMENT_ROOT is required.");
const server = new McpServer({ name: "research-documents", version: "1.0.0" });
const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};
const failure = () => ({
  isError: true,
  content: [
    {
      type: "text" as const,
      text: "Document access failed: check the allowed directory, ID and size limit.",
    },
  ],
});

server.registerTool(
  "list_documents",
  {
    description:
      "List at most 30 Markdown document IDs in the configured research directory.",
    inputSchema: z.object({}).strict(),
    annotations,
  },
  async () => {
    try {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ documents: await listDocuments(root) }),
          },
        ],
      };
    } catch {
      return failure();
    }
  },
);
server.registerTool(
  "read_document",
  {
    description:
      "Read one Markdown document by ID. Read-only, non-recursive, maximum 24000 bytes.",
    inputSchema: z.object({ id: documentIdSchema }).strict(),
    annotations,
  },
  async ({ id }) => {
    try {
      return {
        content: [
          { type: "text", text: JSON.stringify(await readDocument(root, id)) },
        ],
      };
    } catch {
      return failure();
    }
  },
);
await server.connect(new StdioServerTransport());
