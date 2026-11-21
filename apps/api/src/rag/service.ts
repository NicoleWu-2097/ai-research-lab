import { createHash } from "node:crypto";
import { listDocuments, readDocument } from "../mcp/documents.js";
import type { ResearchTools, ToolEventSink } from "../mcp/client.js";
import type { ModelProvider } from "../model/types.js";
import { raceWithAbort } from "../model/deadline.js";
import { formatIndexKey } from "../config/embedding.js";
import {
  buildKnowledgeChunks,
  chunkDocument,
  type Chunk,
  type Hit,
} from "./chunks.js";
import { validateVectors, type Embedder } from "./embedding.js";
import { VectorStore, type StoredDocument } from "./store.js";
import {
  applyMetadataFilters,
  bm25Search,
  deduplicateAndExpandHits,
  reciprocalRankFusion,
  rerankAndFilterHits,
  rewriteAndExpandQueries,
  type SearchKnowledgeBaseInput,
  type SearchKnowledgeBaseResult,
} from "./hybrid.js";
import { resolve } from "node:path";

export class RagError extends Error {
  readonly code = "RAG_FAILED";
  constructor(detail?: string) {
    super(
      detail
        ? `Local retrieval failed: ${detail}`
        : "Local retrieval failed. Check RAG health, then run pnpm --filter @research-lab/api rag:reindex.",
    );
  }
}

/** 检索结果带降级标记；degraded 为真时本轮只使用了稀疏检索。 */
export interface RetrievalStatus {
  hits: Hit[];
  degraded: boolean;
  degradedReason?: string;
}

/** 重灌前的索引配置：current 为现有索引，next 为本次重灌写入的配置。 */
export interface IndexConfiguration {
  current: { embeddingKey: string; indexedAt: string } | null;
  next: string;
}

/** 重灌统计：文档数与片段数取实际入库结果，降级次数为嵌入失败被跳过的已存文档数。 */
export interface ReindexStats {
  documents: number;
  chunks: number;
  degraded: number;
  elapsedMs: number;
}

/** 降级原因取嵌入服务返回的错误信息，报告与事件据此说明证据来源。 */
function embeddingFailureReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `嵌入服务调用失败：${detail}`;
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
    this.indexKey = formatIndexKey(embedder.key, resolve(root));
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
    const vectors = await this.embedDocuments(chunks, signal);
    signal.throwIfAborted();
    await this.store.initialize();
    await this.store.replace(this.indexKey, chunks, vectors, signal);
    return { documents: seen.size, duplicates, chunks: chunks.length };
  }

  /**
   * 重灌：先按资料目录全量替换索引，再把已存文档重建片段与向量追加到同一配置。
   * 已存文档的行保持不变；嵌入失败的文档计入降级并跳过，其余文档照常入库。
   */
  async reindex(signal: AbortSignal): Promise<ReindexStats> {
    const startedAt = Date.now();
    const corpus = await this.ingest(signal);
    const stored = await this.store.listDocuments();
    let documents = corpus.documents;
    let degraded = 0;
    for (const document of stored) {
      signal.throwIfAborted();
      const chunks = this.rebuildStoredChunks(document);
      let vectors: number[][];
      try {
        vectors = await this.embedDocuments(chunks, signal);
      } catch {
        if (signal.aborted) throw signal.reason;
        degraded += 1;
        continue;
      }
      await this.store.append(this.indexKey, chunks, vectors, signal);
      documents += 1;
    }
    const { chunks } = await this.store.health(this.indexKey);
    return { documents, chunks, degraded, elapsedMs: Date.now() - startedAt };
  }

  /** 已存文档按 upload 写入时的分块与元数据形状重建，带上 projectId。 */
  private rebuildStoredChunks(document: StoredDocument) {
    return buildKnowledgeChunks(
      {
        id: document.id,
        content: document.content,
        sha256: document.sha256,
        retrievedAt: new Date().toISOString(),
      },
      {
        projectId: document.projectId,
        source: document.name,
        title: document.name,
        embeddingModel: this.embedder.key,
        embeddingVersion: "chars900-overlap120-v1",
      },
    ).map((chunk) => ({ ...chunk, filename: document.name }));
  }

  /** 分批调用嵌入服务；取消与维度校验对所有入口一致。 */
  private async embedDocuments(chunks: Chunk[], signal: AbortSignal) {
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += 16) {
      const texts = chunks.slice(i, i + 16).map((chunk) => chunk.content);
      vectors.push(
        ...validateVectors(
          await raceWithAbort(
            this.embedder.embed(texts, "document", signal),
            signal,
          ),
          texts.length,
          this.embedder.dimensions,
        ),
      );
    }
    return vectors;
  }

  async upload(
    name: string,
    content: string,
    signal: AbortSignal,
    projectId?: string,
  ) {
    const sha256 = createHash("sha256").update(content).digest("hex");
    const id = projectId
      ? `upload-${projectId}-${sha256}.md`
      : `upload-${sha256}.md`;
    const docSource = {
      id,
      content,
      sha256,
      retrievedAt: new Date().toISOString(),
    };
    const chunks = (
      projectId
        ? buildKnowledgeChunks(docSource, {
            projectId,
            source: name,
            title: name,
            embeddingModel: this.embedder.key,
            embeddingVersion: "chars900-overlap120-v1",
          })
        : chunkDocument(docSource)
    ).map((chunk) => ({
      ...chunk,
      filename: name,
      ...(projectId ? { projectId } : {}),
    }));
    const vectors = await this.embedDocuments(chunks, signal);
    signal.throwIfAborted();
    await this.store.initialize();
    await this.store.append(this.indexKey, chunks, vectors, signal, {
      id,
      projectId: projectId ?? "default",
      name,
      content,
      sha256,
      embeddingKey: this.indexKey,
      updatedAt: new Date().toISOString(),
    });
    return {
      id,
      name,
      chunks: chunks.length,
      ...(projectId ? { projectId } : {}),
    };
  }

  async updateDocument(
    documentId: string,
    name: string,
    content: string,
    signal: AbortSignal,
    projectId = "default",
  ) {
    await this.store.initialize();
    await this.store.deleteDocument(documentId, projectId);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const docSource = {
      id: documentId,
      content,
      sha256,
      retrievedAt: new Date().toISOString(),
    };
    const chunks = buildKnowledgeChunks(docSource, {
      projectId,
      source: name,
      title: name,
      embeddingModel: this.embedder.key,
      embeddingVersion: "chars900-overlap120-v1",
    }).map((c) => ({ ...c, filename: name }));

    const vectors = await this.embedDocuments(chunks, signal);
    await this.store.append(this.indexKey, chunks, vectors, signal, {
      id: documentId,
      projectId,
      name,
      content,
      sha256,
      embeddingKey: this.indexKey,
      updatedAt: new Date().toISOString(),
    });
    return { id: documentId, name, projectId, chunks: chunks.length };
  }

  async deleteDocument(documentId: string, projectId?: string) {
    await this.store.initialize();
    return this.store.deleteDocument(documentId, projectId);
  }

  health() {
    return this.store.health(this.indexKey);
  }

  async indexConfiguration(): Promise<IndexConfiguration> {
    await this.store.initialize();
    return { current: await this.store.currentIndex(), next: this.indexKey };
  }

  async retrieveWithStatus(
    question: string,
    signal: AbortSignal,
    projectId?: string,
  ): Promise<RetrievalStatus> {
    const queries = [question];
    let vectors: number[][] | undefined;
    let degradedReason: string | undefined;
    try {
      vectors = await this.embedQueries(queries, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      degradedReason = embeddingFailureReason(error);
    }
    try {
      if (vectors) {
        signal.throwIfAborted();
        return {
          hits: await raceWithAbort(
            this.store.search(
              this.indexKey,
              vectors[0]!,
              4,
              this.minScore,
              projectId,
            ),
            signal,
          ),
          degraded: false,
        };
      }
      return {
        hits: await this.sparseHits(queries, 4, projectId, signal),
        degraded: true,
        ...(degradedReason ? { degradedReason } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const detail = error instanceof Error ? error.message : String(error);
      throw new RagError(detail);
    }
  }

  async retrieve(
    question: string,
    signal: AbortSignal,
    projectId?: string,
  ): Promise<Hit[]> {
    return (await this.retrieveWithStatus(question, signal, projectId)).hits;
  }

  private async embedQueries(queries: string[], signal: AbortSignal) {
    return validateVectors(
      await raceWithAbort(
        this.embedder.embed(queries, "query", signal),
        signal,
      ),
      queries.length,
      this.embedder.dimensions,
    );
  }

  /** 嵌入服务不可用时的稀疏检索；不计算向量，只按关键词匹配候选片段。 */
  private async sparseHits(
    queries: string[],
    limit: number,
    projectId: string | undefined,
    signal: AbortSignal,
  ): Promise<Hit[]> {
    const chunks = await raceWithAbort(
      this.store.listChunks(this.indexKey, projectId),
      signal,
    );
    const candidates = bm25Search(queries, chunks, Math.max(limit * 2, 8));
    const { hits } = rerankAndFilterHits(queries, candidates, {
      enableReranking: true,
      enableRelevanceFilter: true,
      minScore: Math.min(this.minScore, 0.2),
    });
    return hits.slice(0, limit);
  }

  /**
   * 4.1 & 4.2: Unified Knowledge Base Retrieval Interface supporting
   * Query Rewriting, Multi-Query, Dense, BM25, Hybrid RRF, Reranking,
   * Metadata Filtering, Parent-Child Retrieval, Deduplication, and Relevance Filtering.
   */
  async searchKnowledgeBase(
    input: SearchKnowledgeBaseInput,
    signal = new AbortController().signal,
  ): Promise<SearchKnowledgeBaseResult> {
    const projectId = input.projectId ?? "default";
    const strategy = input.strategy ?? "hybrid";
    const topK = input.topK ?? 4;
    const minScore = input.filters?.minScore ?? this.minScore;

    const rewrittenQueries = rewriteAndExpandQueries(
      input.query,
      input.enableQueryRewrite ?? true,
      input.enableMultiQuery ?? true,
    );

    if (rewrittenQueries.length === 0) {
      return {
        query: input.query,
        rewrittenQueries: [],
        strategy,
        projectId,
        hits: [],
        filteredIrrelevantCount: 0,
        deduplicatedCount: 0,
        rerankLog: [],
        degraded: false,
        emptyReason: "empty_query",
      };
    }

    let vectors: number[][] | undefined;
    let degradedReason: string | undefined;
    if (strategy === "dense" || strategy === "hybrid") {
      try {
        vectors = await this.embedQueries(rewrittenQueries.slice(0, 2), signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        degradedReason = embeddingFailureReason(error);
      }
    }

    try {
      const rankedLists: Hit[][] = [];

      // 1. Dense Vector Search across rewritten queries
      if (vectors) {
        for (const vec of vectors) {
          const denseHits = await raceWithAbort(
            this.store.search(
              this.indexKey,
              vec,
              Math.max(topK * 2, 8),
              minScore,
              input.projectId,
            ),
            signal,
          );
          const filteredDense = applyMetadataFilters(denseHits, {
            projectId: input.projectId,
            documentIds: input.documentIds,
            filters: input.filters,
          });
          if (filteredDense.length > 0) rankedLists.push(filteredDense);
        }
      }

      // 2. BM25 Sparse Search across candidate project chunks
      if (strategy === "bm25" || strategy === "hybrid" || degradedReason) {
        const allChunks = await raceWithAbort(
          this.store.listChunks(this.indexKey, input.projectId),
          signal,
        );
        const filteredChunks = applyMetadataFilters(allChunks, {
          projectId: input.projectId,
          documentIds: input.documentIds,
          filters: input.filters,
        });
        const sparseHits = bm25Search(
          rewrittenQueries,
          filteredChunks,
          Math.max(topK * 2, 8),
        );
        if (sparseHits.length > 0) rankedLists.push(sparseHits);
      }

      // 3. Reciprocal Rank Fusion
      const fusedHits =
        rankedLists.length === 0
          ? []
          : rankedLists.length === 1
            ? rankedLists[0]!
            : reciprocalRankFusion(rankedLists, Math.max(topK * 2, 8));

      // 4. Reranking & Relevance Judgment
      const {
        hits: relevantHits,
        filteredIrrelevantCount,
        rerankLog,
      } = rerankAndFilterHits(rewrittenQueries, fusedHits, {
        enableReranking: input.enableReranking ?? true,
        enableRelevanceFilter: input.enableRelevanceFilter ?? true,
        minScore: Math.min(minScore, 0.2),
      });

      // 5. Parent-Child Expansion & Deduplication
      const { hits: finalHits, deduplicatedCount } = deduplicateAndExpandHits(
        relevantHits,
        {
          enableParentChild: input.enableParentChild ?? false,
          enableDeduplication: input.enableDeduplication ?? true,
          topK,
        },
      );

      return {
        query: input.query,
        rewrittenQueries,
        strategy,
        projectId,
        hits: finalHits,
        filteredIrrelevantCount,
        deduplicatedCount,
        rerankLog,
        degraded: !!degradedReason,
        ...(degradedReason ? { degradedReason } : {}),
        ...(finalHits.length === 0
          ? {
              emptyReason:
                filteredIrrelevantCount > 0
                  ? "no_relevant_evidence_after_filtering"
                  : "no_matching_chunks",
            }
          : {}),
      };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const detail = error instanceof Error ? error.message : String(error);
      throw new RagError(detail);
    }
  }

  async collect(
    question: string,
    _provider: ModelProvider,
    signal: AbortSignal,
    emit: ToolEventSink,
  ) {
    await emit("RETRIEVAL_STARTED", { message: "正在检索本地文档片段。" });
    const status = await this.retrieveWithStatus(question, signal);
    if (status.degraded)
      await emit("RETRIEVAL_DEGRADED", {
        strategy: "sparse",
        reason: status.degradedReason ?? "",
        message: `嵌入服务不可用，本轮降级为仅使用稀疏检索：${status.degradedReason ?? ""}`,
      });
    const hits = status.hits.map((hit, index) => ({
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
