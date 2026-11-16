import { runRagScript } from "./script.js";

await runRagScript(
  "Ingestion",
  "RAG ingestion failed; check database, documents, embedding model and dimensions. Previous index was preserved unless replacement already committed.",
  async (rag, signal) => {
    console.info(JSON.stringify(await rag.service.ingest(signal)));
  },
);
