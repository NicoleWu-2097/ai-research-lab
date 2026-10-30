import { readAgentEndpoints } from "./a2a/client.js";
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { createApp } from "./app.js";
import { createModelProvider, readModelConfig } from "./model/config.js";
import { McpDocumentTools } from "./mcp/client.js";
import { createRag } from "./rag/config.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    MCP_ENABLED: z.enum(["true", "false"]).default("true"),
    RAG_ENABLED: z.enum(["true", "false"]).default("false"),
    AGENTIC_RAG_ENABLED: z.enum(["true", "false"]).default("true"),
    RESEARCH_LOOP_ENABLED: z.enum(["true", "false"]).default("true"),
    MULTI_AGENT_ENABLED: z.enum(["true", "false"]).default("true"),
    MCP_DOCUMENT_ROOT: z.string().trim().min(1).optional(),
  })
  .parse(process.env);

const modelConfig = readModelConfig(process.env);
const provider = modelConfig ? createModelProvider(modelConfig) : null;
const documentRoot = config.MCP_DOCUMENT_ROOT
  ? resolve(config.MCP_DOCUMENT_ROOT)
  : fileURLToPath(new URL("../../../docs/decisions", import.meta.url));
const tools =
  config.MCP_ENABLED === "true" ? new McpDocumentTools(documentRoot) : null;
const rag = config.RAG_ENABLED === "true" ? createRag(process.env) : null;
const endpoints = readAgentEndpoints(process.env);
const app = createApp(
  provider,
  modelConfig?.timeoutMs,
  tools,
  rag?.service,
  config.AGENTIC_RAG_ENABLED === "true",
  config.MULTI_AGENT_ENABLED === "true",
  endpoints,
  config.RESEARCH_LOOP_ENABLED === "true" &&
    config.AGENTIC_RAG_ENABLED === "true" &&
    config.MULTI_AGENT_ENABLED === "true",
);

const server = serve({ fetch: app.fetch, port: config.PORT });
console.info(
  JSON.stringify({
    event: "SERVER_STARTED",
    service: "api",
    port: config.PORT,
    modelProvider: provider?.provider ?? "unconfigured",
    model: provider?.model ?? null,
    mcpEnabled: tools !== null,
    ragEnabled: rag !== null,
    multiAgentEnabled:
      config.AGENTIC_RAG_ENABLED === "true" &&
      config.MULTI_AGENT_ENABLED === "true",
    endpoints,
    researchLoopEnabled:
      config.RESEARCH_LOOP_ENABLED === "true" &&
      config.AGENTIC_RAG_ENABLED === "true" &&
      config.MULTI_AGENT_ENABLED === "true",
    a2aEnabled: endpoints !== null,
    agenticEnabled: config.AGENTIC_RAG_ENABLED === "true",
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void (rag?.close() ?? Promise.resolve()).finally(() => process.exit(0));
    });
  });
}
