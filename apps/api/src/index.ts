import { BraveSearch, DynamicBraveSearch } from "./search/brave.js";
import { createHash } from "node:crypto";
import { HumanStore } from "./human/store.js";
import { HumanService } from "./human/service.js";
import { postgresDatabase } from "./rag/store.js";
import { readDatabaseConfig } from "./rag/database-config.js";
import { readAgentEndpoints } from "./a2a/client.js";
import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { createApp } from "./app.js";
import { assertNoOllama } from "./config/no-ollama.js";
import { readEmbeddingInfo } from "./config/embedding.js";
import { createModelProvider, readModelConfig } from "./model/config.js";
import { McpDocumentTools } from "./mcp/client.js";
import { createRag } from "./rag/config.js";

if (existsSync(".env")) process.loadEnvFile(".env");
assertNoOllama(process.env);

const config = z
  .object({
    HUMAN_ENABLED: z.enum(["true", "false"]).default("false"),
    APPROVAL_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1000)
      .max(604800000)
      .default(86400000),
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
const embeddingInfo = readEmbeddingInfo(process.env);
const provider = modelConfig ? createModelProvider(modelConfig) : null;
const documentRoot = config.MCP_DOCUMENT_ROOT
  ? resolve(config.MCP_DOCUMENT_ROOT)
  : fileURLToPath(new URL("../../../docs/decisions", import.meta.url));
const tools =
  config.MCP_ENABLED === "true" ? new McpDocumentTools(documentRoot) : null;
const rag = config.RAG_ENABLED === "true" ? createRag(process.env) : null;
const endpoints = readAgentEndpoints(process.env);
const braveApiKey = (
  process.env.BRAVE_SEARCH_API_KEY ??
  process.env.BRAVE_API_KEY ??
  ""
).trim();
const web =
  process.env.WEB_SEARCH_ENABLED === "true"
    ? braveApiKey.length > 0
      ? new BraveSearch(braveApiKey)
      : config.HUMAN_ENABLED === "true"
        ? new DynamicBraveSearch()
        : null
    : null;
if (web && config.HUMAN_ENABLED !== "true")
  throw new Error("Web search requires durable human mode");
let human: HumanService | null = null;
let humanDb: ReturnType<typeof postgresDatabase> | null = null;
if (config.HUMAN_ENABLED === "true") {
  if (
    !provider ||
    config.RESEARCH_LOOP_ENABLED !== "true" ||
    config.MULTI_AGENT_ENABLED !== "true" ||
    config.AGENTIC_RAG_ENABLED !== "true"
  )
    throw new Error("Human mode requires a model and the M9 research loop.");
  humanDb = postgresDatabase(readDatabaseConfig(process.env));
  const store = new HumanStore(humanDb.database, config.APPROVAL_TIMEOUT_MS);
  await store.initialize();
  const keys = [
    "DATABASE_URL",
    "RAG_DOCUMENT_ROOT",
    "EMBEDDING_PROVIDER",
    "EMBEDDING_MODEL",
    "EMBEDDING_DIMENSIONS",
    "EMBEDDING_BASE_URL",
    "RAG_MIN_SCORE",
    "OLLAMA_BASE_URL",
  ];
  const configKey = createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        openaiEndpoint: process.env.OPENAI_BASE_URL,
        openaiStyle: process.env.OPENAI_API_STYLE,
        openaiAuth: process.env.OPENAI_AUTH_HEADER,
        model: provider.model,
        provider: provider.provider,
        root: documentRoot,
        endpoints,
        rag: !!rag,
        tools: !!tools,
        env: keys.map((k) => process.env[k]),
      }),
    )
    .digest("hex");
  human = new HumanService(
    store,
    provider,
    modelConfig!.timeoutMs,
    rag?.service ?? null,
    tools,
    endpoints,
    configKey,
    web,
  );
}
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
  human,
  web,
);

const server = serve({
  fetch: app.fetch,
  port: config.PORT,
  ...(human ? { hostname: "127.0.0.1" } : {}),
});
console.info(
  JSON.stringify({
    event: "SERVER_STARTED",
    service: "api",
    port: config.PORT,
    modelProvider: provider?.provider ?? "unconfigured",
    model: provider?.model ?? null,
    embeddingProvider: embeddingInfo?.provider ?? null,
    embeddingModel: embeddingInfo?.model ?? null,
    embeddingBaseUrl: embeddingInfo?.baseUrl ?? null,
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
    humanEnabled: human !== null,
    a2aEnabled: endpoints !== null,
    agenticEnabled: config.AGENTIC_RAG_ENABLED === "true",
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void Promise.all([rag?.close(), humanDb?.close()]).finally(() =>
        process.exit(0),
      );
    });
  });
}
