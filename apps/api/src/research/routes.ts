import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createDeadline } from "../model/deadline.js";
import { toModelError, type ModelProvider } from "../model/types.js";
import { runResearch } from "./workflow.js";
import { McpToolError, type ResearchTools } from "../mcp/client.js";
import { RagError } from "../rag/service.js";

const requestSchema = z.object({
  question: z.string().trim().min(1).max(8000),
});

export function researchRoutes(
  provider: ModelProvider | null,
  timeoutMs: number,
  tools: ResearchTools | null = null,
) {
  const routes = new Hono();
  routes.post("/stream", async (context) => {
    const request = requestSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!request.success)
      return context.json(
        { error: { message: "Provide a question of 1–8000 characters." } },
        400,
      );
    if (!provider)
      return context.json(
        {
          error: {
            message: "Configure a model provider before starting research.",
          },
        },
        503,
      );

    const taskId = randomUUID();
    return streamSSE(context, async (stream) => {
      const deadline = createDeadline(context.req.raw.signal, timeoutMs);
      stream.onAbort(deadline.cancel);
      let sequence = 0;
      const emit = async (type: string, payload: Record<string, unknown>) => {
        const event = {
          taskId,
          sequence: ++sequence,
          timestamp: new Date().toISOString(),
          type,
          ...payload,
        };
        if (type !== "REPORT_DELTA")
          console.info(
            JSON.stringify({
              event: type,
              taskId,
              sequence,
              provider: provider.provider,
              model: provider.model,
            }),
          );
        await stream.writeSSE({
          id: String(sequence),
          event: "research",
          data: JSON.stringify(event),
        });
      };
      try {
        await emit("TASK_CREATED", { status: "queued" });
        await emit("AGENT_STARTED", { status: "running", agent: "research" });
        const report = await runResearch(
          request.data.question,
          provider,
          deadline.signal,
          (text) => emit("REPORT_DELTA", { text }),
          tools,
          emit,
        );
        deadline.signal.throwIfAborted();
        await emit("AGENT_COMPLETED", { status: "completed", report });
      } catch (error) {
        const failure =
          !deadline.signal.aborted &&
          (error instanceof McpToolError || error instanceof RagError)
            ? error
            : toModelError(error, deadline.signal);
        const cancelled = failure.code === "MODEL_CANCELLED";
        console.info(
          JSON.stringify({
            event: cancelled ? "TASK_CANCELLED" : "AGENT_FAILED",
            taskId,
            code: failure.code,
          }),
        );
        if (!stream.aborted)
          await emit(cancelled ? "TASK_CANCELLED" : "AGENT_FAILED", {
            status: cancelled ? "cancelled" : "failed",
            code: failure.code,
            message: failure.message,
          });
      } finally {
        deadline.dispose();
      }
    });
  });
  return routes;
}
