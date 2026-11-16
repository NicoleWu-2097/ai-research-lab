import type { Hit } from "../rag/chunks.js";
import type { Evidence } from "./types.js";

/**
 * 6.1 Unified Evidence Store
 * Manages traceable evidence across RAG, Web Search, Academic Papers, and Workspace Files.
 */
export class EvidenceStore {
  private readonly items = new Map<string, Evidence>();
  private readonly byTask = new Map<string, string[]>();
  private readonly byProject = new Map<string, string[]>();

  add(
    input: Omit<Evidence, "id" | "retrievedAt"> & {
      id?: string;
      retrievedAt?: string;
    },
  ): Evidence {
    const taskIds = this.byTask.get(input.taskId) ?? [];
    // Deduplicate within the same task by sourceId + originalText
    for (const existingId of taskIds) {
      const existing = this.items.get(existingId);
      if (
        existing &&
        existing.sourceId === input.sourceId &&
        existing.originalText.trim() === input.originalText.trim()
      ) {
        return existing;
      }
    }

    const prefix =
      input.sourceType === "rag"
        ? "RAG"
        : input.sourceType === "web"
          ? "WEB"
          : input.sourceType === "paper"
            ? "PAPER"
            : "FILE";
    const index = taskIds.length + 1;
    const id = input.id ?? `${prefix}:${index}`;
    const record: Evidence = {
      ...input,
      id,
      retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    };

    this.items.set(id, record);
    taskIds.push(id);
    this.byTask.set(input.taskId, taskIds);

    if (input.projectId) {
      const projIds = this.byProject.get(input.projectId) ?? [];
      if (!projIds.includes(id)) {
        projIds.push(id);
        this.byProject.set(input.projectId, projIds);
      }
    }

    return record;
  }

  addRagHits(taskId: string, projectId: string, hits: Hit[]): Evidence[] {
    return hits.map((hit, idx) =>
      this.add({
        id: hit.id.startsWith("RAG:") && /^RAG:\d+$/.test(hit.id)
          ? hit.id
          : `RAG:${(this.byTask.get(taskId)?.length ?? 0) + 1}`,
        taskId,
        projectId,
        sourceId: hit.documentId || hit.id,
        sourceType: "rag",
        documentId: hit.documentId,
        chunkId: hit.id,
        ...(hit.metadata?.title ? { title: hit.metadata.title } : {}),
        originalText: hit.content,
        locator: {
          ...(hit.metadata?.page !== undefined
            ? { page: hit.metadata.page }
            : {}),
          ...(hit.metadata?.section ? { section: hit.metadata.section } : {}),
          startOffset: hit.start,
          endOffset: hit.end,
          startLine: hit.startLine,
          endLine: hit.endLine,
        },
        retrievedAt: hit.retrievedAt,
        relevanceScore: hit.score,
        metadata: {
          sha256: hit.sha256,
          rank: idx + 1,
        },
      }),
    );
  }

  get(id: string): Evidence | undefined {
    return this.items.get(id);
  }

  getForTask(taskId: string): Evidence[] {
    const ids = this.byTask.get(taskId) ?? [];
    return ids
      .map((id) => this.items.get(id))
      .filter((e): e is Evidence => e !== undefined);
  }

  getForProject(projectId: string): Evidence[] {
    const ids = this.byProject.get(projectId) ?? [];
    return ids
      .map((id) => this.items.get(id))
      .filter((e): e is Evidence => e !== undefined);
  }

  clearTask(taskId: string): void {
    const ids = this.byTask.get(taskId) ?? [];
    for (const id of ids) {
      this.items.delete(id);
    }
    this.byTask.delete(taskId);
  }
}
