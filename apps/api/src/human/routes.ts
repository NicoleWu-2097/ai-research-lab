import { Hono } from "hono";
import { z } from "zod";
import { HumanConflict } from "./store.js";
import type { HumanService } from "./service.js";
const actor = z.string().trim().min(1).max(80);
const question = z.string().trim().min(1).max(8000);
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
    const body = z
      .object({ question, actor, clarify: z.boolean().default(false) })
      .parse(await c.req.json());
    const result = await service.store.create(
      body.question,
      body.actor,
      body.clarify,
      service.configKey,
    );
    if (!body.clarify) await service.start(result.task.id, result.key);
    return c.json({ id: result.task.id, key: result.key }, 201);
  });
  const credentials = (id: string, key: string | undefined) => ({
    id: z.uuid().parse(id),
    key: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(key),
  });
  routes.get("/:id", async (c) => {
    const { id, key } = credentials(
      c.req.param("id"),
      c.req.header("x-research-key"),
    );
    return c.json(await service.store.read(id, key));
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
