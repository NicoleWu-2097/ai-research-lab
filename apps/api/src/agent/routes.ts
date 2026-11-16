import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { createDeadline } from "../model/deadline.js";
import type { AtlasAgentRuntime } from "./runtime.js";

const executeSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  projectId: z.string().trim().min(1).max(120).optional(),
  sessionId: z.string().trim().min(1).max(120).optional(),
  workspaceRoot: z.string().trim().min(1).max(1000).optional(),
  verificationMode: z
    .enum(["general", "research", "strict_research"])
    .optional(),
  requireUserConfirmation: z.boolean().optional(),
});

const projectSchema = z.object({
  projectId: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).optional(),
  workspaceRoot: z.string().trim().min(1).max(1000).optional(),
});

export function agentRoutes(runtime: AtlasAgentRuntime, timeoutMs = 60_000) {
  const routes = new Hono();

  routes.post("/execute", async (c) => {
    const parsed = executeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Provide a valid message (1–8000 chars).",
          },
        },
        400,
      );
    }
    if (!runtime.provider) {
      return c.json(
        {
          error: {
            code: "MODEL_NOT_CONFIGURED",
            message: "Configure a model provider before executing tasks.",
          },
        },
        503,
      );
    }

    const deadline = createDeadline(c.req.raw.signal, timeoutMs);
    try {
      const result = await runtime.execute({
        ...parsed.data,
        signal: deadline.signal,
      });
      return c.json(result);
    } finally {
      deadline.dispose();
    }
  });

  routes.post("/stream", async (c) => {
    const parsed = executeSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "INVALID_REQUEST",
            message: "Provide a valid message (1–8000 chars).",
          },
        },
        400,
      );
    }
    if (!runtime.provider) {
      return c.json(
        {
          error: {
            code: "MODEL_NOT_CONFIGURED",
            message: "Configure a model provider before executing tasks.",
          },
        },
        503,
      );
    }

    return streamSSE(c, async (stream) => {
      const deadline = createDeadline(c.req.raw.signal, timeoutMs);
      stream.onAbort(deadline.cancel);
      try {
        await runtime.execute({
          ...parsed.data,
          signal: deadline.signal,
          onEvent: async (event) => {
            if (!stream.aborted) {
              await stream.writeSSE({
                id: String(event.sequence),
                event: "agent",
                data: JSON.stringify(event),
              });
            }
          },
          onDelta: async (delta) => {
            if (!stream.aborted) {
              await stream.writeSSE({
                event: "delta",
                data: JSON.stringify({ text: delta }),
              });
            }
          },
        });
      } finally {
        deadline.dispose();
      }
    });
  });

  routes.get("/tasks/:id", (c) => {
    const id = c.req.param("id");
    const taskState = runtime.getTask(id);
    if (!taskState) {
      return c.json({ error: "Task not found." }, 404);
    }
    const trace = runtime.traceCollector.getTraceByTaskId(id);
    const evidences = runtime.evidenceStore.getForTask(id);
    return c.json({
      taskState,
      evidences,
      artifacts: taskState.artifacts,
      trace,
    });
  });

  routes.get("/traces", (c) => {
    const projectId = c.req.query("projectId");
    return c.json({
      traces: runtime.traceCollector.listTraces(projectId),
    });
  });

  routes.get("/traces/:traceId", (c) => {
    const trace = runtime.traceCollector.getTrace(c.req.param("traceId"));
    if (!trace) return c.json({ error: "Trace not found." }, 404);
    return c.json(trace);
  });

  routes.get("/projects", (c) => {
    return c.json({
      activeProjectId: runtime.contextManager.getActiveProjectId(),
      projects: runtime.contextManager.listProjects(),
    });
  });

  routes.post("/projects/switch", async (c) => {
    const parsed = projectSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: "Invalid project payload." }, 400);
    }
    const project = runtime.contextManager.switchProject(
      parsed.data.projectId,
      {
        name: parsed.data.name,
        description: parsed.data.description,
        workspaceRoot: parsed.data.workspaceRoot,
      },
    );
    return c.json({
      activeProjectId: project.projectId,
      project,
    });
  });

  routes.delete("/projects/:projectId", (c) => {
    const projectId = c.req.param("projectId");
    const deleted = runtime.contextManager.deleteProject(projectId);
    if (!deleted) return c.json({ error: "Project not found." }, 404);
    return c.json({
      deleted: true,
      projectId,
      activeProjectId: runtime.contextManager.getActiveProjectId(),
    });
  });

  return routes;
}
