import { createHash } from "node:crypto";
import type { DocumentSource } from "../mcp/documents.js";

export interface Chunk extends DocumentSource {
  ingestedAt: string;
  documentId: string;
  start: number;
  end: number;
  startLine: number;
  endLine: number;
}
export interface Hit extends Chunk {
  score: number;
}

export function chunkDocument(document: DocumentSource): Chunk[] {
  const chunks: Chunk[] = [];
  const text = document.content;
  for (let start = 0; start < text.length;) {
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
