import express from "express";
import { setTimeout as delay } from "node:timers/promises";
import { createRoleApp } from "../../src/a2a/server.js";
import type { AgentRole } from "../../src/a2a/contracts.js";
import type { ResearchAgents } from "../../src/research/review.js";

const role = process.argv[2] as AgentRole;
let calls = 0;
const run = async (question: string, signal: AbortSignal) => {
  calls++;
  if (question === "fail") throw new Error("private error must not escape");
  if (question === "slow") await delay(800, undefined, { signal });
  if (question === "timeout") await delay(10000, undefined, { signal });
};
const agents: ResearchAgents = {
  async research(input, signal) {
    await run(input.question, signal);
    return input.question === "bad-citation"
      ? "unknown [RAG:99]"
      : "仅记录设计决策 [RAG:1]";
  },
  async critique(input, signal) {
    await run(input.question, signal);
    return input.question === "bad-review"
      ? { verdict: "approve", issues: ["conflict"], summary: "invalid" }
      : { verdict: "approve", issues: [], summary: "证据支持" };
  },
};
const app = express();
const server = app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const service = createRoleApp(role, endpoint, agents, 1500);
  app.get("/test/calls", (_req, res) => res.json({ calls }));
  app.use(service.app);
  console.log(JSON.stringify({ endpoint, pid: process.pid }));
  process.on("SIGTERM", () => {
    service.cancelAll();
    server.close(() => process.exit(0));
  });
});
