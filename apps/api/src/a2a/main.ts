import { existsSync } from "node:fs";
import { z } from "zod";
import {
  createModelProvider,
  readModelConfig,
  requireModelProvider,
} from "../model/config.js";
import { createResearchAgents } from "../research/review.js";
import { createRoleApp } from "./server.js";

if (existsSync(".env")) process.loadEnvFile(".env");
const role = z.enum(["researcher", "critic"]).parse(process.argv[2]);
const port = z.coerce
  .number()
  .int()
  .min(1)
  .max(65535)
  .parse(process.env.A2A_PORT ?? (role === "researcher" ? 4101 : 4102));
const config = readModelConfig(process.env);
const provider = requireModelProvider(
  config ? createModelProvider(config) : null,
);
const service = createRoleApp(
  role,
  `http://127.0.0.1:${port}`,
  createResearchAgents(provider, async () => undefined),
  config!.timeoutMs,
);
const server = service.app.listen(port, "127.0.0.1", () =>
  console.info(
    JSON.stringify({
      event: "A2A_SERVER_STARTED",
      role,
      port,
      pid: process.pid,
      model: provider.model,
    }),
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    service.cancelAll();
    server.close(() => process.exit(0));
  });
