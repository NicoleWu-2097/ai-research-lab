import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { z } from "zod";
import { createDeadline, raceWithAbort } from "../model/deadline.js";
import type { RagService } from "./service.js";

const PROBE_TEXT = "health check";

async function probeEmbedding(
  rag: RagService,
  model: string | null,
  timeoutMs: number,
  parentSignal: AbortSignal,
) {
  const expectedDimensions = rag.embedder.dimensions;
  const deadline = createDeadline(parentSignal, timeoutMs);
  try {
    const [vector] = await raceWithAbort(
      rag.embedder.embed([PROBE_TEXT], "query", deadline.signal),
      deadline.signal,
    );
    const actualDimensions = vector?.length ?? 0;
    if (actualDimensions !== expectedDimensions)
      return {
        ok: false,
        model,
        expectedDimensions,
        actualDimensions,
        error: `Embedding dimensions mismatch: expected ${expectedDimensions}, received ${actualDimensions}.`,
      };
    return { ok: true, model, expectedDimensions, actualDimensions };
  } catch (error) {
    return {
      ok: false,
      model,
      expectedDimensions,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deadline.dispose();
  }
}

export function ragRoutes(
  rag: RagService | null,
  timeoutMs: number,
  embeddingModel: string | null = null,
) {
  const routes = new Hono();
  routes.post("/upload", bodyLimit({ maxSize: 32000 }), async (c) => {
    const origin = c.req.header("origin");
    if (
      !["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname) ||
      (origin && !["localhost", "127.0.0.1"].includes(new URL(origin).hostname))
    )
      return c.json({ error: "仅支持本机上传。" }, 403);
    if (!rag) return c.json({ error: "请先启用 RAG 并配置 embedding。" }, 503);
    const deadline = createDeadline(c.req.raw.signal, timeoutMs);
    try {
      const body = await c.req.parseBody();
      const file = body.file;
      const projectId =
        typeof body.projectId === "string" && body.projectId.trim()
          ? body.projectId.trim()
          : undefined;
      if (
        !(file instanceof File) ||
        !/\.(md|txt)$/i.test(file.name) ||
        file.size > 24000
      )
        return c.json(
          { error: "请选择不超过 24 KB 的 UTF-8 .md 或 .txt 文件。" },
          400,
        );
      const content = new TextDecoder("utf-8", { fatal: true }).decode(
        await file.arrayBuffer(),
      );
      if (!content.trim() || content.includes("\0"))
        return c.json({ error: "文件为空或不是文本。" }, 400);
      return c.json(
        await raceWithAbort(
          rag.upload(file.name, content, deadline.signal, projectId),
          deadline.signal,
        ),
        201,
      );
    } catch (error) {
      // 只返回可操作的分类，不透传可能包含服务地址或凭证的 SDK 异常。
      const cause = error instanceof Error ? error.cause : undefined;
      const code =
        cause && typeof cause === "object" && "code" in cause
          ? cause.code
          : undefined;
      const message = deadline.signal.aborted
        ? "上传索引超时，请检查 embedding 服务并重试。"
        : code === "ECONNREFUSED"
          ? "无法连接 embedding 服务。使用本地 Ollama 时，请先运行 ollama serve。"
          : error instanceof TypeError &&
              /encoded data|encoding/i.test(error.message)
            ? "文件不是有效的 UTF-8 文本，请转换编码后重试。"
            : error instanceof Error &&
                error.message === "Reingest before uploading"
              ? "embedding 配置与现有索引不一致，请先重新摄取资料。"
              : "上传索引失败，请检查 embedding 模型、向量维度及数据库配置。";
      return c.json({ error: message }, 503);
    } finally {
      deadline.dispose();
    }
  });
  routes.get("/health", async (context) => {
    if (!rag) return context.json({ status: "disabled" }, 503);
    try {
      const health = await rag.health();
      const probe =
        context.req.query("probe") === "true"
          ? await probeEmbedding(
              rag,
              embeddingModel,
              timeoutMs,
              context.req.raw.signal,
            )
          : undefined;
      return context.json(
        {
          status: health.compatible ? "ready" : "needs_ingestion",
          ...health,
          ...(probe ? { probe } : {}),
        },
        health.compatible ? 200 : 503,
      );
    } catch {
      return context.json({ status: "unavailable" }, 503);
    }
  });
  routes.post("/retrieve", async (context) => {
    const body = z
      .object({
        question: z.string().trim().min(1).max(8000),
        projectId: z.string().trim().min(1).optional(),
      })
      .safeParse(await context.req.json().catch(() => null));
    if (!body.success)
      return context.json(
        { error: "Provide a question of 1–8000 characters." },
        400,
      );
    if (!rag) return context.json({ error: "RAG is disabled." }, 503);
    const deadline = createDeadline(context.req.raw.signal, timeoutMs);
    try {
      return context.json({
        sources: await raceWithAbort(
          rag.retrieve(
            body.data.question,
            deadline.signal,
            body.data.projectId,
          ),
          deadline.signal,
        ),
      });
    } catch {
      return context.json(
        {
          error:
            "Retrieval unavailable; check RAG health, embedding service and ingestion.",
        },
        503,
      );
    } finally {
      deadline.dispose();
    }
  });
  routes.post("/search", async (context) => {
    const body = z
      .object({
        query: z.string().trim().min(1).max(8000),
        projectId: z.string().trim().min(1).optional(),
        documentIds: z.array(z.string()).optional(),
        topK: z.number().int().min(1).max(20).optional(),
        strategy: z.enum(["dense", "bm25", "hybrid"]).optional(),
        filters: z
          .object({
            source: z.string().optional(),
            section: z.string().optional(),
            page: z.number().int().optional(),
            minScore: z.number().optional(),
          })
          .optional(),
      })
      .safeParse(await context.req.json().catch(() => null));
    if (!body.success)
      return context.json(
        { error: "Provide a valid searchKnowledgeBase payload." },
        400,
      );
    if (!rag) return context.json({ error: "RAG is disabled." }, 503);
    const deadline = createDeadline(context.req.raw.signal, timeoutMs);
    try {
      const result = await raceWithAbort(
        rag.searchKnowledgeBase(body.data, deadline.signal),
        deadline.signal,
      );
      return context.json(result);
    } catch {
      return context.json(
        {
          error:
            "Knowledge base search failed; check RAG health and embedding service.",
        },
        503,
      );
    } finally {
      deadline.dispose();
    }
  });
  return routes;
}
