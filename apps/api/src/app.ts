import type { HumanService } from "./human/service.js";
import { humanRoutes } from "./human/routes.js";
import type { AgentEndpoints } from "./a2a/client.js";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { researchRoutes } from "./research/routes.js";
import type { ResearchTools } from "./mcp/client.js";
import type { RagService } from "./rag/service.js";
import { ragRoutes } from "./rag/routes.js";

import { createDeadline, raceWithAbort } from "./model/deadline.js";
import { requireModelProvider } from "./model/config.js";
import { ModelError, toModelError, type ModelProvider } from "./model/types.js";

const promptSchema = z.object({ prompt: z.string().trim().min(1).max(8_000) });

function errorStatus(error: ModelError): 503 | 504 | 408 | 422 | 502 {
  switch (error.code) {
    case "MODEL_NOT_CONFIGURED":
      return 503;
    case "MODEL_TIMEOUT":
      return 504;
    case "MODEL_CANCELLED":
      return 408;
    case "MODEL_UNSUPPORTED_CAPABILITY":
      return 422;
    case "MODEL_INVALID_OUTPUT":
    case "MODEL_PROVIDER_ERROR":
      return 502;
  }
}

export function createApp(
  provider: ModelProvider | null,
  timeoutMs = 60_000,
  tools: ResearchTools | null = null,
  rag: RagService | null = null,
  agentic = false,
  multiAgent = false,
  endpoints: AgentEndpoints | null = null,
  loop = false,
  human: HumanService | null = null,
) {
  const app = new Hono();
  if (human) {
    app.route("/api/research/tasks", humanRoutes(human));
    app.use("/api/research/stream", async (c) =>
      c.json({ error: "人工介入已启用，请使用持久化任务接口。" }, 409),
    );
  }
  app.route(
    "/api/research",
    researchRoutes(
      provider,
      timeoutMs,
      tools,
      rag,
      agentic,
      multiAgent,
      endpoints,
      loop,
    ),
  );
  app.route("/api/rag", ragRoutes(rag, timeoutMs));

  app.get("/api/health", (context) =>
    context.json({
      status: "ok",
      service: "api",
      ...(human ? { humanEnabled: true } : {}),
    } as const),
  );

  app.post("/api/model/generate", async (context) => {
    const body = promptSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success) {
      return context.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Provide a prompt of 1–8000 characters.",
          },
        },
        400,
      );
    }

    let selected: ModelProvider;
    try {
      selected = requireModelProvider(provider);
    } catch (error) {
      const modelError = error as ModelError;
      return context.json(
        { error: { code: modelError.code, message: modelError.message } },
        503,
      );
    }

    const deadline = createDeadline(context.req.raw.signal, timeoutMs);
    try {
      const text = await raceWithAbort(
        selected.generate(body.data.prompt, deadline.signal),
        deadline.signal,
      );
      return context.json({
        provider: selected.provider,
        model: selected.model,
        text,
      });
    } catch (error) {
      const modelError = toModelError(error, deadline.signal);
      console.error(
        JSON.stringify({
          event: "MODEL_FAILED",
          provider: selected.provider,
          model: selected.model,
          code: modelError.code,
        }),
      );
      return context.json(
        { error: { code: modelError.code, message: modelError.message } },
        errorStatus(modelError),
      );
    } finally {
      deadline.dispose();
    }
  });

  app.post("/api/model/stream", async (context) => {
    const body = promptSchema.safeParse(
      await context.req.json().catch(() => null),
    );
    if (!body.success) {
      return context.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Provide a prompt of 1–8000 characters.",
          },
        },
        400,
      );
    }

    let selected: ModelProvider;
    try {
      selected = requireModelProvider(provider);
    } catch (error) {
      const modelError = error as ModelError;
      return context.json(
        { error: { code: modelError.code, message: modelError.message } },
        503,
      );
    }

    return streamSSE(context, async (stream) => {
      const deadline = createDeadline(context.req.raw.signal, timeoutMs);
      stream.onAbort(deadline.cancel);
      const output = selected.stream(body.data.prompt, deadline.signal);
      const iterator = output[Symbol.asyncIterator]();
      try {
        while (true) {
          const result = await raceWithAbort(iterator.next(), deadline.signal);
          if (result.done) break;
          await stream.writeSSE({
            event: "delta",
            data: JSON.stringify({ text: result.value }),
          });
        }
        await stream.writeSSE({ event: "done", data: "{}" });
      } catch (error) {
        const modelError = toModelError(error, deadline.signal);
        console.error(
          JSON.stringify({
            event: "MODEL_FAILED",
            provider: selected.provider,
            model: selected.model,
            code: modelError.code,
          }),
        );
        if (!stream.aborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              code: modelError.code,
              message: modelError.message,
            }),
          });
        }
      } finally {
        deadline.dispose();
        void iterator.return?.().catch(() => undefined);
      }
    });
  });

  return app;
}

export const app = createApp(null);
