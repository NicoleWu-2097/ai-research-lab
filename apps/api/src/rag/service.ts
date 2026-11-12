import { createHash } from "node:crypto";
import { listDocuments, readDocument } from "../mcp/documents.js";
import type { ResearchTools, ToolEventSink } from "../mcp/client.js";
import type { ModelProvider } from "../model/types.js";
import { raceWithAbort } from "../model/deadline.js";
import { chunkDocument, type Chunk } from "./chunks.js";
import { validateVectors, type Embedder } from "./embedding.js";
import { VectorStore } from "./store.js";
import { resolve } from "node:path";

export class RagError extends Error {
  readonly code = "RAG_FAILED";
  constructor() {
    super(
      "Local retrieval failed. Check RAG health and reingest the configured documents.",
    );
  }
}

export class RagService implements ResearchTools {
  readonly evidenceOnly = true;
  private readonly indexKey: string;
  constructor(
    readonly store: VectorStore,
    readonly embedder: Embedder,
    readonly root: string,
    readonly minScore = 0.4,
  ) {
    this.indexKey = JSON.stringify([embedder.key, resolve(root)]);
  }

  async ingest(signal: AbortSignal) {
    const ids = await listDocuments(this.root);
    const seen = new Set<string>();
    const chunks: Chunk[] = [];
    let duplicates = 0;
    for (const id of ids) {
      signal.throwIfAborted();
      const document = await readDocument(this.root, id);
      if (seen.has(document.sha256)) {
        duplicates++;
        continue;
      }
      seen.add(document.sha256);
      chunks.push(...chunkDocument(document));
    }
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 16) {
      const texts = chunks.slice(i, i + 16).map((chunk) => chunk.content);
      vectors.push(
        ...validateVectors(
          await raceWithAbort(this.embedder.embed(texts, signal), signal),
          texts.length,
          this.embedder.dimensions,
        ),
      );
    }
    signal.throwIfAborted();
    await this.store.initialize();
    await this.store.replace(this.indexKey, chunks, vectors, signal);
    return { documents: seen.size, duplicates, chunks: chunks.length };
  }

  async upload(name: string, content: string, signal: AbortSignal) {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const id = `upload-${sha256}.md`;
    const chunks = chunkDocument({
      id,
      content,
      sha256,
      retrievedAt: new Date().toISOString(),
    }).map((chunk) => ({ ...chunk, filename: name }));
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 16) {
      const texts = chunks.slice(i, i + 16).map((chunk) => chunk.content);
      vectors.push(
        ...validateVectors(
          await this.embedder.embed(texts, signal),
          texts.length,
          this.embedder.dimensions,
        ),
      );
    }
    signal.throwIfAborted();
    await this.store.initialize();
    await this.store.append(this.indexKey, chunks, vectors, signal);
    return { id, name, chunks: chunks.length };
  }

  health() {
    return this.store.health(this.indexKey);
  }

  async retrieve(question: string, signal: AbortSignal) {
    try {
      const vectors = validateVectors(
        await raceWithAbort(this.embedder.embed([question], signal), signal),
        1,
        this.embedder.dimensions,
      );
      signal.throwIfAborted();
      return await raceWithAbort(
        this.store.search(this.indexKey, vectors[0]!, 4, this.minScore),
        signal,
      );
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new RagError();
    }
  }

  async collect(
    question: string,
    _provider: ModelProvider,
    signal: AbortSignal,
    emit: ToolEventSink,
  ) {
    await emit("RETRIEVAL_STARTED", { message: "正在检索本地文档片段。" });
    const hits = (await this.retrieve(question, signal)).map((hit, index) => ({
      ...hit,
      chunkId: hit.id,
      id: `RAG:${index + 1}`,
    }));
    await emit("RETRIEVAL_COMPLETED", {
      sources: hits,
      message: `检索命中 ${hits.length} 个片段。`,
    });
    return hits;
  }
}
