// Explicit real-model smoke check with an ephemeral embedded PostgreSQL database.
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createEmbedder } from "../src/rag/embedding.js";
import { RagService } from "../src/rag/service.js";
import { VectorStore } from "../src/rag/store.js";
import { createModelProvider, readModelConfig } from "../src/model/config.js";
import { createApp } from "../src/app.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const config = readModelConfig(process.env);
if (!config) throw new Error("Configure LLM_PROVIDER and generation model.");
const db = new PGlite({ extensions: { vector } });
try {
  const rag = new RagService(
    new VectorStore(db),
    createEmbedder(process.env),
    fileURLToPath(new URL("../../../docs/decisions", import.meta.url)),
    0.4,
  );
  console.info("Ingestion:", await rag.ingest(AbortSignal.timeout(120000)));
  const response = await createApp(
    createModelProvider(config),
    180000,
    null,
    rag,
  ).request("/api/research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question:
        "这个项目为什么选择 PostgreSQL 和 pgvector？请引用检索片段并说明局限。",
    }),
  });
  const text = await response.text();
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
  for (const event of events)
    if (
      ["RETRIEVAL_COMPLETED", "AGENT_COMPLETED", "AGENT_FAILED"].includes(
        String(event.type),
      )
    )
      console.info(JSON.stringify(event));
  if (
    !events.some((event) => event.type === "CITATIONS_VALIDATED") ||
    !events.some((event) => event.type === "AGENT_COMPLETED")
  ) {
    console.error(
      "Unvalidated draft:",
      events
        .filter((event) => event.type === "REPORT_DELTA")
        .map((event) => event.text)
        .join(""),
    );
    throw new Error("Smoke check failed.");
  }
} finally {
  await db.close();
}
