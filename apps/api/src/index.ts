import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { z } from "zod";

import { createApp } from "./app.js";
import { createModelProvider, readModelConfig } from "./model/config.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const config = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  })
  .parse(process.env);

const modelConfig = readModelConfig(process.env);
const provider = modelConfig ? createModelProvider(modelConfig) : null;
const app = createApp(provider, modelConfig?.timeoutMs);

const server = serve({ fetch: app.fetch, port: config.PORT });
console.info(
  JSON.stringify({
    event: "SERVER_STARTED",
    service: "api",
    port: config.PORT,
    modelProvider: provider?.provider ?? "unconfigured",
    model: provider?.model ?? null,
  }),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
