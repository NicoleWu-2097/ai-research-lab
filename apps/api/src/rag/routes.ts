import { Hono } from "hono";
import { z } from "zod";
import { createDeadline, raceWithAbort } from "../model/deadline.js";
import type { RagService } from "./service.js";

export function ragRoutes(rag: RagService | null, timeoutMs: number) {
  const routes = new Hono();
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
