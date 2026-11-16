import type { Chunk, Hit } from "./chunks.js";

export type RetrievalStrategy = "dense" | "bm25" | "hybrid";

export interface SearchFilters {
  source?: string | undefined;
  section?: string | undefined;
  page?: number | undefined;
  minScore?: number | undefined;
}

export interface SearchKnowledgeBaseInput {
  query: string;
  projectId?: string | undefined;
  documentIds?: string[] | undefined;
  filters?: SearchFilters | undefined;
  topK?: number | undefined;
  strategy?: RetrievalStrategy | undefined;
  enableQueryRewrite?: boolean | undefined;
  enableMultiQuery?: boolean | undefined;
  enableReranking?: boolean | undefined;
  enableParentChild?: boolean | undefined;
  enableDeduplication?: boolean | undefined;
  enableRelevanceFilter?: boolean | undefined;
}

export interface RerankRecord {
  id: string;
  documentId: string;
  beforeScore: number;
  afterScore: number;
  relevant: boolean;
}

export interface SearchKnowledgeBaseResult {
  query: string;
  rewrittenQueries: string[];
  strategy: RetrievalStrategy;
  projectId: string;
  hits: Hit[];
  filteredIrrelevantCount: number;
  deduplicatedCount: number;
  rerankLog: RerankRecord[];
  emptyReason?: string;
}

/**
 * Bilingual CJK + English tokenizer for BM25 and lexical relevance scoring.
 * Extracts English/alphanumeric tokens, single CJK characters, and CJK bi-grams.
 */
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "to",
  "of",
  "in",
  "on",
  "for",
  "and",
  "or",
  "with",
  "as",
  "by",
  "at",
  "from",
  "what",
  "why",
  "how",
  "which",
  "who",
  "can",
  "could",
  "should",
  "would",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "的",
  "了",
  "是",
  "在",
  "和",
  "与",
  "或",
  "有",
  "有哪些",
  "什么",
  "为什么",
  "如何",
  "怎么",
  "可以",
  "方面",
  "关于",
  "进行",
  "一个",
  "我们",
  "你们",
  "他们",
]);

const BILINGUAL_GLOSSARY: Record<string, string[]> = {
  花: ["flower", "floral", "blossom", "petal"],
  红色: ["red", "anthocyanin", "pigment", "color", "花青素", "色素"],
  植物: ["plant", "botany", "botanical"],
  花青素: ["anthocyanin", "pigment", "red"],
  用户体验: ["ux", "ui", "user", "experience", "interface", "交互", "界面"],
  ux: ["用户体验", "交互", "界面", "前端", "web", "cli", "改进"],
  改进: ["improvement", "enhance", "optimize", "refactor", "优化"],
  检索: ["retrieval", "search", "rag", "vector", "bm25"],
  数据库: ["database", "postgres", "postgresql", "pgvector", "sql", "存储"],
  存储: ["storage", "database", "postgres", "postgresql", "persistence"],
  向量: ["vector", "embedding", "pgvector"],
  引用: ["citation", "evidence", "reference", "quote", "source"],
  证据: ["evidence", "citation", "source", "grounding"],
  工具: ["tool", "mcp", "function", "capability"],
  智能体: ["agent", "agentic", "workflow", "loop", "runtime"],
};

export function tokenizeText(text: string): string[] {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens: string[] = [];

  // Extract ASCII / Latin words
  const wordMatches = normalized.match(/[a-z0-9_]+/g) ?? [];
  for (const w of wordMatches) {
    if (w.length >= 2 && !STOPWORDS.has(w)) {
      tokens.push(w);
    }
  }

  // Extract contiguous CJK sequences -> unigrams & bigrams
  const cjkBlocks = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const block of cjkBlocks) {
    const cleaned = [...block].filter((ch) => !STOPWORDS.has(ch)).join("");
    for (let i = 0; i < cleaned.length; i++) {
      const uni = cleaned[i]!;
      if (!STOPWORDS.has(uni)) tokens.push(uni);
      if (i + 1 < cleaned.length) {
        const bi = cleaned.slice(i, i + 2);
        if (!STOPWORDS.has(bi)) tokens.push(bi);
      }
    }
  }

  return tokens;
}

/**
 * 4.2 (1 & 2): Query Rewriting & Multi-Query Expansion (including cross-lingual expansion)
 */
export function rewriteAndExpandQueries(
  query: string,
  enableRewrite = true,
  enableMultiQuery = true,
): string[] {
  const base = query.trim();
  if (!base) return [];
  const results = new Set<string>([base]);

  if (enableRewrite) {
    // Strip conversational filler in Chinese and English
    const stripped = base
      .replace(
        /^(请问|帮我|请解释|解释一下|分析一下|研究一下|告诉我|please|explain|what is|why are|why is|how does)\s*/i,
        "",
      )
      .replace(/[？?。！!]+$/g, "")
      .trim();
    if (stripped && stripped.length >= 2) {
      results.add(stripped);
    }
  }

  if (enableMultiQuery) {
    const lower = base.toLowerCase();
    const expansionTerms: string[] = [];
    for (const [key, synonyms] of Object.entries(BILINGUAL_GLOSSARY)) {
      if (lower.includes(key)) {
        expansionTerms.push(...synonyms.slice(0, 3));
      }
    }
    if (expansionTerms.length > 0) {
      results.add(`${base} ${expansionTerms.join(" ")}`);
    }
  }

  return [...results].slice(0, 4);
}

/**
 * 4.2 (4): BM25 Sparse Retrieval over candidate chunks
 */
export function bm25Search(
  queries: string[],
  chunks: Chunk[],
  topK: number,
  k1 = 1.5,
  b = 0.75,
): Hit[] {
  if (chunks.length === 0 || queries.length === 0) return [];

  const queryTokens = [
    ...new Set(queries.flatMap((q) => tokenizeText(q))),
  ];
  if (queryTokens.length === 0) return [];

  const docTokensList = chunks.map((c) =>
    tokenizeText(`${c.documentId} ${c.metadata?.title ?? ""} ${c.metadata?.section ?? ""} ${c.content}`),
  );
  const avgDl =
    docTokensList.reduce((sum, toks) => sum + toks.length, 0) /
    Math.max(1, chunks.length);

  // Document frequency per query token
  const df = new Map<string, number>();
  for (const qt of queryTokens) {
    let count = 0;
    for (const docTokens of docTokensList) {
      if (docTokens.includes(qt)) count++;
    }
    df.set(qt, count);
  }

  const N = chunks.length;
  const scored: Hit[] = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;
    const docTokens = docTokensList[i]!;
    const dl = docTokens.length;
    if (dl === 0) continue;

    const tfMap = new Map<string, number>();
    for (const t of docTokens) {
      tfMap.set(t, (tfMap.get(t) ?? 0) + 1);
    }

    let score = 0;
    for (const qt of queryTokens) {
      const tf = tfMap.get(qt) ?? 0;
      if (tf === 0) continue;
      const n_q = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n_q + 0.5) / (n_q + 0.5));
      const num = tf * (k1 + 1);
      const den = tf + k1 * (1 - b + b * (dl / Math.max(1, avgDl)));
      score += idf * (num / den);
    }

    if (score > 0) {
      // Normalize BM25 score into (0, 1] range for uniform comparability
      const normalizedScore = Number((score / (score + 2.5)).toFixed(4));
      scored.push({
        ...chunk,
        score: normalizedScore,
        retrievedAt: new Date().toISOString(),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.slice(0, topK);
}

/**
 * 4.2 (6): Reciprocal Rank Fusion (RRF)
 */
export function reciprocalRankFusion(
  rankedLists: Hit[][],
  topK: number,
  rrfK = 60,
): Hit[] {
  const fused = new Map<
    string,
    { hit: Hit; rrfScore: number; maxRawScore: number }
  >();

  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank++) {
      const hit = list[rank]!;
      const contribution = 1 / (rrfK + rank + 1);
      const existing = fused.get(hit.id);
      if (existing) {
        existing.rrfScore += contribution;
        existing.maxRawScore = Math.max(existing.maxRawScore, hit.score);
      } else {
        fused.set(hit.id, {
          hit,
          rrfScore: contribution,
          maxRawScore: hit.score,
        });
      }
    }
  }

  const merged = [...fused.values()]
    .sort(
      (a, b) =>
        b.rrfScore - a.rrfScore ||
        b.maxRawScore - a.maxRawScore ||
        a.hit.id.localeCompare(b.hit.id),
    )
    .slice(0, topK)
    .map(({ hit, maxRawScore, rrfScore }) => ({
      ...hit,
      // Combine raw score and scaled RRF so downstream threshold checks work naturally
      score: Number(
        Math.max(maxRawScore, Math.min(1, rrfScore * rrfK)).toFixed(4),
      ),
    }));

  return merged;
}

/**
 * 4.2 (8): Metadata Filtering
 */
export function applyMetadataFilters<T extends Chunk>(
  chunks: T[],
  options: {
    projectId?: string | undefined;
    documentIds?: string[] | undefined;
    filters?: SearchFilters | undefined;
  },
): T[] {
  return chunks.filter((chunk) => {
    // Strict project isolation: if projectId is specified and chunk has a projectId, they must match
    if (options.projectId && chunk.projectId) {
      if (chunk.projectId !== options.projectId) return false;
    }
    if (options.documentIds && options.documentIds.length > 0) {
      const docSet = new Set(options.documentIds);
      if (
        !docSet.has(chunk.documentId) &&
        !docSet.has(chunk.id) &&
        !(chunk.metadata?.source && docSet.has(chunk.metadata.source))
      ) {
        return false;
      }
    }
    if (options.filters?.source) {
      const src = chunk.metadata?.source ?? chunk.documentId;
      if (!src.toLowerCase().includes(options.filters.source.toLowerCase())) {
        return false;
      }
    }
    if (options.filters?.section) {
      const sec = chunk.metadata?.section ?? "";
      if (!sec.toLowerCase().includes(options.filters.section.toLowerCase())) {
        return false;
      }
    }
    if (options.filters?.page !== undefined) {
      if (chunk.metadata?.page !== options.filters.page) {
        return false;
      }
    }
    return true;
  });
}

/**
 * 4.2 (7) & 4.4: Reranking & Domain Relevance Judgment
 * Ensures irrelevant chunks (e.g. botany documents when asking about Atlas UX) are filtered out.
 */
export function rerankAndFilterHits(
  queries: string[],
  hits: Hit[],
  options: {
    enableReranking?: boolean;
    enableRelevanceFilter?: boolean;
    minScore?: number;
  } = {},
): {
  hits: Hit[];
  filteredIrrelevantCount: number;
  rerankLog: RerankRecord[];
} {
  const enableReranking = options.enableReranking ?? true;
  const enableRelevanceFilter = options.enableRelevanceFilter ?? true;
  const queryTokens = new Set(queries.flatMap((q) => tokenizeText(q)));

  const rerankLog: RerankRecord[] = [];
  const kept: Hit[] = [];
  let filteredIrrelevantCount = 0;

  for (const hit of hits) {
    const beforeScore = hit.score ?? 0;
    const chunkTokens = new Set(
      tokenizeText(
        `${hit.documentId} ${hit.metadata?.title ?? ""} ${hit.metadata?.section ?? ""} ${hit.content}`,
      ),
    );

    let overlapCount = 0;
    for (const qt of queryTokens) {
      if (chunkTokens.has(qt)) overlapCount++;
    }

    const lexicalCoverage =
      queryTokens.size > 0 ? overlapCount / queryTokens.size : 0;

    // Reranked score blends vector/BM25 base score with lexical coverage
    const afterScore = enableReranking
      ? Number((beforeScore * 0.7 + lexicalCoverage * 0.3).toFixed(4))
      : beforeScore;

    // Relevance check:
    // A hit is relevant if:
    // 1. It has lexical overlap with the query (or bilingual expanded query), OR
    // 2. Its dense vector score is high (>= 0.75) and there isn't a blatant domain mismatch
    const hasLexicalOverlap = overlapCount > 0;
    const highDenseConfidence = beforeScore >= 0.75;
    const relevant = !enableRelevanceFilter
      ? true
      : hasLexicalOverlap || highDenseConfidence;

    rerankLog.push({
      id: hit.id,
      documentId: hit.documentId,
      beforeScore,
      afterScore,
      relevant,
    });

    const effectiveMinScore = hasLexicalOverlap
      ? Math.min(options.minScore ?? 0.05, 0.05)
      : (options.minScore ?? 0.15);
    if (relevant && afterScore >= effectiveMinScore) {
      kept.push({
        ...hit,
        score: enableReranking ? Math.max(beforeScore, afterScore) : beforeScore,
      });
    } else {
      filteredIrrelevantCount++;
    }
  }

  if (enableReranking) {
    kept.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  }

  return {
    hits: kept,
    filteredIrrelevantCount,
    rerankLog,
  };
}

/**
 * 4.2 (9 & 10): Parent-Child Context Expansion & Context Deduplication
 */
export function deduplicateAndExpandHits(
  hits: Hit[],
  options: {
    enableParentChild?: boolean;
    enableDeduplication?: boolean;
    topK?: number;
  } = {},
): { hits: Hit[]; deduplicatedCount: number } {
  const enableDeduplication = options.enableDeduplication ?? true;
  const enableParentChild = options.enableParentChild ?? false;
  const topK = options.topK ?? 6;

  if (!enableDeduplication) {
    return { hits: hits.slice(0, topK), deduplicatedCount: 0 };
  }

  const seenIds = new Set<string>();
  const seenParentIds = new Set<string>();
  const seenContentHashes = new Set<string>();
  const result: Hit[] = [];
  let deduplicatedCount = 0;

  for (const hit of hits) {
    const contentKey = hit.content.trim().toLowerCase();
    if (seenIds.has(hit.id) || seenContentHashes.has(contentKey)) {
      deduplicatedCount++;
      continue;
    }
    if (
      enableParentChild &&
      hit.parentChunkId &&
      seenParentIds.has(hit.parentChunkId)
    ) {
      deduplicatedCount++;
      continue;
    }

    seenIds.add(hit.id);
    seenContentHashes.add(contentKey);
    if (hit.parentChunkId) seenParentIds.add(hit.parentChunkId);

    result.push(
      enableParentChild && hit.parentText
        ? {
            ...hit,
            content: hit.parentText,
            text: hit.parentText,
          }
        : hit,
    );

    if (result.length >= topK) break;
  }

  return { hits: result, deduplicatedCount };
}
