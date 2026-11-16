import { createHash } from "node:crypto";
import type { DocumentSource } from "../mcp/documents.js";

export interface KnowledgeChunkMetadata {
  source: string;
  title?: string;
  section?: string;
  page?: number;
  startOffset?: number;
  endOffset?: number;
  parentChunkId?: string;
}

export interface KnowledgeChunk {
  id: string;
  projectId: string;
  documentId: string;
  text: string;
  metadata: KnowledgeChunkMetadata;
  embeddingModel: string;
  embeddingVersion?: string;
  parentText?: string;
}

export interface Chunk extends DocumentSource {
  ingestedAt: string;
  documentId: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  projectId?: string;
  text?: string;
  metadata?: KnowledgeChunkMetadata;
  embeddingModel?: string;
  embeddingVersion?: string;
  parentChunkId?: string;
  parentText?: string;
}

export interface Hit extends Chunk {
  score: number;
}

export function extractMarkdownMeta(
  text: string,
  offset: number,
): { title?: string; section?: string; page?: number } {
  const before = text.slice(0, offset);
  const titleMatch = text.match(/^#\s+(.+)$/m);
  const headings = [...before.matchAll(/^#{1,4}\s+(.+)$/gm)];
  const pageMatches = [
    ...before.matchAll(/(?:\[Page\s*(\d+)\]|<!--\s*page:\s*(\d+)\s*-->)/gi),
  ];
  const lastHeading = headings.at(-1)?.[1]?.trim();
  const lastPage = pageMatches.at(-1);
  const pageNum = lastPage ? Number(lastPage[1] ?? lastPage[2]) : undefined;
  return {
    ...(titleMatch?.[1] ? { title: titleMatch[1].trim() } : {}),
    ...(lastHeading ? { section: lastHeading } : {}),
    ...(pageNum && Number.isFinite(pageNum) ? { page: pageNum } : {}),
  };
}

export function chunkDocument(document: DocumentSource): Chunk[] {
  const chunks: Chunk[] = [];
  const text = document.content;
  for (let start = 0; start < text.length; ) {
    let end = Math.min(start + 900, text.length);
    // Do not cut a UTF-16 surrogate pair in half.
    if (end < text.length && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
    const content = text.slice(start, end);
    if (content.trim())
      chunks.push({
        ...document,
        ingestedAt: document.retrievedAt,
        id: `RAG:${createHash("sha256").update(`${document.id}:${document.sha256}:${start}:${end}`).digest("hex")}`,
        documentId: document.id,
        content,
        start,
        end,
        startLine: text.slice(0, start).split("\n").length,
        endLine: text.slice(0, Math.max(start, end - 1)).split("\n").length,
      });
    if (end === text.length) break;
    start = end - 120;
    if (/[\uDC00-\uDFFF]/.test(text[start]!)) start++;
  }
  return chunks;
}

export function buildKnowledgeChunks(
  document: DocumentSource,
  options: {
    projectId?: string;
    source?: string;
    title?: string;
    embeddingModel?: string;
    embeddingVersion?: string;
    chunkSize?: number;
    overlap?: number;
  } = {},
): Array<Chunk & KnowledgeChunk> {
  const projectId = options.projectId ?? "default";
  const embeddingModel = options.embeddingModel ?? "local-default";
  const embeddingVersion = options.embeddingVersion ?? "chars900-overlap120-v1";
  const baseChunks = chunkDocument(document);
  const fullText = document.content;

  return baseChunks.map((chunk) => {
    const mdMeta = extractMarkdownMeta(fullText, chunk.start);
    // Compute parent window around the child chunk for parent-child retrieval
    const parentStart = Math.max(0, chunk.start - 450);
    const parentEnd = Math.min(fullText.length, chunk.end + 450);
    const parentText = fullText.slice(parentStart, parentEnd);
    const parentChunkId = `PARENT:${createHash("sha256").update(`${projectId}:${document.id}:${parentStart}:${parentEnd}`).digest("hex").slice(0, 24)}`;
    const metadata: KnowledgeChunkMetadata = {
      source: options.source ?? document.id,
      ...(options.title ?? mdMeta.title
        ? { title: options.title ?? mdMeta.title }
        : {}),
      ...(mdMeta.section ? { section: mdMeta.section } : {}),
      ...(mdMeta.page !== undefined ? { page: mdMeta.page } : {}),
      startOffset: chunk.start,
      endOffset: chunk.end,
      parentChunkId,
    };
    return {
      ...chunk,
      projectId,
      text: chunk.content,
      metadata,
      embeddingModel,
      embeddingVersion,
      parentChunkId,
      parentText,
    };
  });
}
