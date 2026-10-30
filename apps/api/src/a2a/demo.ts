import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readDocument } from "../mcp/documents.js";
import { chunkDocument } from "../rag/chunks.js";
import { createDeadline } from "../model/deadline.js";
import { runReviewedResearch } from "../research/review.js";
import { createRemoteAgents, readAgentEndpoints } from "./client.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const endpoints = readAgentEndpoints({ ...process.env, A2A_ENABLED: "true" })!;
const deadline = createDeadline(new AbortController().signal, 300000);
const cancel = process.argv.includes("--cancel");
const emit = async (type: string, payload: Record<string, unknown>) => {
  console.log(JSON.stringify({ type, ...payload }));
  if (cancel && type === "A2A_PROGRESS") deadline.cancel();
};
try {
  const root = fileURLToPath(
    new URL("../../../../docs/decisions", import.meta.url),
  );
  const document = await readDocument(
    root,
    "0003-storage-and-protocol-boundaries.md",
  );
  const sources = chunkDocument(document)
    .slice(0, 8)
    .map((source, index) => ({ ...source, id: `RAG:${index + 1}` }));
  const report = await runReviewedResearch(
    {
      question:
        "请只依据这份 ADR，简短解释 PostgreSQL 和 pgvector 的选型理由。不要推断实施状态，每条理由引用片段。",
      sources,
    },
    createRemoteAgents(endpoints, emit),
    deadline.signal,
    emit,
  );
  console.log(report);
} catch (error) {
  console.error(error instanceof Error ? error.message : "A2A demo failed");
  if (!(cancel && deadline.signal.aborted)) process.exitCode = 1;
} finally {
  deadline.dispose();
}
