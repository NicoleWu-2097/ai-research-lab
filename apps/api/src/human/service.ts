import { randomUUID } from "node:crypto";
import { createDeadline } from "../model/deadline.js";
import type { ModelProvider } from "../model/types.js";
import type { ResearchTools } from "../mcp/client.js";
import type { LocalRetriever } from "../research/agentic.js";
import {
  runResearchLoop,
  type LoopHooks,
  type LoopSnapshot,
} from "../research/loop.js";
import { ResearchBudget } from "../research/budget.js";
import { createRemoteAgents, type AgentEndpoints } from "../a2a/client.js";
import { HumanConflict, HumanStore } from "./store.js";
class Paused extends Error {}
export class HumanService {
  readonly active = new Map<string, Promise<void>>();
  constructor(
    readonly store: HumanStore,
    readonly provider: ModelProvider,
    readonly timeoutMs: number,
    readonly local: LocalRetriever | null,
    readonly tools: ResearchTools | null,
    readonly endpoints: AgentEndpoints | null,
    readonly configKey: string,
  ) {}
  async start(id: string, key: string) {
    const owner = randomUUID();
    const task = await this.store.change(id, key, (task) => {
      if (task.configKey !== this.configKey)
        throw new HumanConflict("运行配置已改变，请恢复原配置或新建任务。");
      if (!["queued", "ready", "running"].includes(task.status))
        throw new HumanConflict("当前任务不能恢复。");
      if (task.status === "running" && Date.parse(task.leaseUntil) > Date.now())
        throw new HumanConflict("任务仍在执行；不能重复启动。");
      if (task.snapshot?.phase === "inflight") {
        task.status = "interrupted";
        task.error =
          "外部调用结果不确定；为避免重复执行，不自动重放。请新建任务。";
        return { actor: "system", action: "interrupted", detail: {} };
      }
      task.status = "running";
      task.owner = owner;
      task.leaseUntil = new Date(
        Date.now() + this.timeoutMs + 5000,
      ).toISOString();
      return { actor: "system", action: "started", detail: {} };
    });
    if (task.status !== "running") return;
    const work = this.execute(task.id, key, owner, task.question, task.snapshot)
      .catch(() => undefined)
      .finally(() => this.active.delete(id));
    this.active.set(id, work);
  }
  private async execute(
    id: string,
    key: string,
    owner: string,
    question: string,
    resume: LoopSnapshot | null,
  ) {
    const started = Date.now(),
      previous = resume?.elapsedMs ?? 0;
    const deadline = createDeadline(
      new AbortController().signal,
      Math.max(1, this.timeoutMs - previous),
    );
    const save: LoopHooks["before"] = async (node, state, budget) => {
      await this.store.change(id, key, (task) => {
        if (task.status !== "running" || task.owner !== owner)
          throw new HumanConflict("任务执行权已失效。");
        task.snapshot = {
          version: 1,
          state,
          next: node,
          phase: "inflight",
          calls: budget.calls,
          units: budget.units,
          retries: budget.retries,
          elapsedMs: previous + Date.now() - started,
        };
        return { actor: "system", action: "node_started", detail: { node } };
      });
    };
    try {
      if (previous >= this.timeoutMs)
        throw new Error("Execution time exhausted");
      const report = await runResearchLoop(
        question,
        this.provider,
        deadline.signal,
        async () => {},
        this.local,
        this.tools,
        async () => {},
        this.endpoints
          ? createRemoteAgents(this.endpoints, async () => {})
          : null,
        new ResearchBudget(),
        {
          ...(resume ? { resume } : {}),
          before: save,
          after: async (node, state, next, budget) => {
            const pause = node === "planning" && next === "research";
            await this.store.change(id, key, (task) => {
              if (task.status !== "running" || task.owner !== owner)
                throw new HumanConflict("任务执行权已失效。");
              task.snapshot = {
                version: 1,
                state,
                next,
                phase: "ready",
                calls: budget.calls,
                units: budget.units,
                retries: budget.retries,
                elapsedMs: previous + Date.now() - started,
              };
              if (pause) {
                task.status = "pending";
                task.approval = this.store.approval(
                  state.plan.action === "mcp"
                    ? "tool"
                    : state.round
                      ? "plan_adjustment"
                      : "plan",
                  question,
                  state.plan.query,
                  state.plan.questions,
                  `${state.plan.reason}${state.plan.action === "mcp" ? "；将通过 MCP 子进程读取可信目录中的一份本地文档，不联网、不写入。" : "；批准后执行本地检索。"}`,
                );
              }
              return {
                actor: "system",
                action: pause ? "approval_requested" : "node_completed",
                detail: { node, approval: task.approval },
              };
            });
            if (pause) throw new Paused();
          },
        },
      );
      await this.store.change(id, key, (task) => {
        if (task.owner !== owner || task.status !== "running")
          throw new HumanConflict("任务状态已改变。");
        task.status = "completed";
        task.report = report;
        return { actor: "system", action: "completed", detail: {} };
      });
    } catch (error) {
      if (!(error instanceof Paused))
        await this.store.change(id, key, (task) => {
          if (task.status !== "running" || task.owner !== owner) return;
          task.status = "failed";
          task.error = deadline.signal.aborted
            ? "执行超时或取消。"
            : "研究执行失败；未发布未验证报告。";
          return {
            actor: "system",
            action: "failed",
            detail: { message: task.error },
          };
        });
    } finally {
      deadline.dispose();
    }
  }
}
