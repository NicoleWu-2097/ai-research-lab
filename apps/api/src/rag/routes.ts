import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { z } from "zod";
import { createDeadline, raceWithAbort } from "../model/deadline.js";
import type { RagService } from "./service.js";

export function ragRoutes(rag: RagService | null, timeoutMs: number) {
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
          rag.upload(file.name, content, deadline.signal),
          deadline.signal,
        ),
        201,
      );
    } catch {
      return c.json(
        { error: "上传索引失败，请检查文件编码、RAG 配置及 embedding 服务。" },
        503,
      );
    } finally {
      deadline.dispose();
    }
  });
  routes.get("/health", async (context) => {
    if (!rag) return context.json({ status: "disabled" }, 503);
    try {
      const health = await rag.health();
      return context.json(
        { status: health.compatible ? "ready" : "needs_ingestion", ...health },
        health.compatible ? 200 : 503,
      );
    } catch {
      return context.json({ status: "unavailable" }, 503);
    }
  });
  routes.post("/retrieve", async (context) => {
    const body = z
      .object({ question: z.string().trim().min(1).max(8000) })
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
          rag.retrieve(body.data.question, deadline.signal),
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
  return routes;
}
