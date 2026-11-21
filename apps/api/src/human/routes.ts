import { streamSSE } from "hono/streaming";
import { Hono } from "hono";
import { z } from "zod";
import { HumanConflict } from "./store.js";
import type { HumanService } from "./service.js";
const actor = z.string().trim().min(1).max(80);
const question = z.string().trim().min(1).max(8000);
const messageInput = z
  .object({
    message: question.optional(),
    question: question.optional(),
    actor,
  })
  .refine((body) => !!(body.message ?? body.question), "message is required")
  .refine(
    (body) => !body.message || !body.question || body.message === body.question,
    "message and question conflict",
  )
  .transform((body) => ({
    message: body.message ?? body.question!,
    actor: body.actor,
  }));
export function humanRoutes(service: HumanService) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    const origin = c.req.header("origin");
    const host = new URL(c.req.url).hostname;
    if (
      origin &&
      !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)
    )
      return c.json({ error: "仅支持本机使用。" }, 403);
    if (!["localhost", "127.0.0.1"].includes(host))
      return c.json({ error: "仅支持本机使用。" }, 403);
    await next();
  });
  routes.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof HumanConflict
            ? error.message
            : "请求或持久化操作失败。",
      },
      error instanceof HumanConflict
        ? 409
        : error instanceof z.ZodError
          ? 400
          : 500,
    ),
  );
  routes.post("/", async (c) => {
    const raw = await c.req.json();
    const body = messageInput.parse(raw);
    const { clarify } = z
      .object({ clarify: z.boolean().default(false) })
      .parse(raw);
    const result = await service.store.create(
      body.message,
      body.actor,
      clarify,
      service.configKey,
    );
    if (!clarify) await service.start(result.task.id, result.key);
    return c.json(
      { id: result.task.id, key: result.key, title: result.task.title },
      201,
    );
  });
  const credentials = (id: string, key: string | undefined) => ({
    id: z.uuid().parse(id),
    key: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(key),
  });
  routes.get("/:id/events", async (c) => {
    const { id, key } = credentials(
      c.req.param("id"),
      c.req.header("x-research-key"),
    );
    const after = z.coerce
      .number()
      .int()
      .min(0)
      .parse(c.req.query("after") ?? c.req.header("last-event-id") ?? "0");
    const task = await service.store.read(id, key);
    return streamSSE(c, async (stream) => {
      for (const event of task.audit) {
        const row = event as { seq: string | number };
        if (Number(row.seq) > after)
          await stream.writeSSE({
            id: String(row.seq),
            event: "research",
            data: JSON.stringify(event),
          });
      }
    });
  });
  routes.get("/:id", async (c) => {
    const { id, key } = credentials(
      c.req.param("id"),
      c.req.header("x-research-key"),
    );
    return c.json(await service.store.read(id, key));
  });
  routes.delete("/:id", async (c) => {
    const { id, key } = credentials(
      c.req.param("id"),
      c.req.header("x-research-key"),
    );
    return c.json(await service.store.delete(id, key));
  });
  for (const action of ["approve", "reject"] as const)
    routes.post(`/:id/${action}`, async (c) => {
      const { id, key } = credentials(
        c.req.param("id"),
        c.req.header("x-research-key"),
      );
      const body = z
        .object({ approvalId: z.uuid(), actor, value: question.optional() })
        .parse(await c.req.json());
      await service.store.decide(
        id,
        key,
        body.approvalId,
        body.actor,
        action === "approve",
        body.value,
      );
      if (action === "approve") await service.start(id, key);
      return c.json({ ok: true });
    });
  routes.post("/:id/continue", async (c) => {
    const { id, key } = credentials(
      c.req.param("id"),
      c.req.header("x-research-key"),
    );
    const body = z
      .object({ actor, instructions: z.string().trim().max(2000).default("") })
      .parse(await c.req.json());
    await service.store.followup(id, key, body.instructions, body.actor, true);
    await service.start(id, key);
    return c.json({ ok: true });
  });
  routes.post("/:id/followup", async (c) => {
    const { id, key } = credentials(
      c.req.param("id"),
      c.req.header("x-research-key"),
    );
    const body = messageInput.parse(await c.req.json());
    await service.store.followup(id, key, body.message, body.actor);
    await service.start(id, key);
    return c.json({ ok: true });
  });
  routes.post("/:id/resume", async (c) => {
    const { id, key } = credentials(
      c.req.param("id"),
      c.req.header("x-research-key"),
    );
    const body = z.object({ actor }).parse(await c.req.json());
    await service.store.change(id, key, () => ({
      actor: body.actor,
      action: "resume_requested",
      detail: {},
    }));
    await service.start(id, key);
    return c.json({ ok: true });
  });
  return routes;
}
