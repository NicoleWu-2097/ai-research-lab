import { existsSync } from "node:fs";
import { createRag } from "./config.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const rag = createRag(process.env);
const controller = new AbortController();
const cancel = () => controller.abort(new Error("Ingestion cancelled."));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  console.info(
    JSON.stringify(
      await rag.service.ingest(
        AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
      ),
    ),
  );
} catch {
  console.error(
    "RAG ingestion failed; check database, documents, embedding model and dimensions. Previous index was preserved unless replacement already committed.",
  );
  process.exitCode = 1;
} finally {
  await rag.close();
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
