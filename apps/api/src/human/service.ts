import { randomUUID } from "node:crypto";
import { createDeadline } from "../model/deadline.js";
import { ModelError, type ModelProvider } from "../model/types.js";
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
// 内部控制信号：审批信息已成功落库，借助异常中断本次图执行，不代表任务失败。
class Paused extends Error {}
// 将研究图与持久化、人工审批和节点间恢复连接起来。HTTP 校验由 routes 负责。
export class HumanService {
  // 当前进程中的后台 Promise，便于跟踪执行；跨进程互斥依赖数据库中的 owner 和租约。
  readonly active = new Map<string, Promise<void>>();
  // 依次注入持久化、模型、执行时限、本地检索、MCP、可选远程角色和配置指纹。
  constructor(
    readonly store: HumanStore,
    readonly provider: ModelProvider,
    readonly timeoutMs: number,
    readonly local: LocalRetriever | null,
    readonly tools: ResearchTools | null,
    readonly endpoints: AgentEndpoints | null,
    readonly configKey: string,
    readonly web: LocalRetriever | null = null,
  ) {}
  // 新建任务或批准后均从这里启动；key 用于访问任务，owner 标识本次执行者。
  async start(id: string, key: string) {
    const owner = randomUUID();
    // change 在事务中锁定任务行，并把状态变化和返回的审计事件一起提交。
    const task = await this.store.change(id, key, (task) => {
      // 防止恢复时使用与创建任务时不同的关键模型、工具或运行配置。
      if (task.configKey !== this.configKey)
        throw new HumanConflict("运行配置已改变，请恢复原配置或新建任务。");
      // 只有排队、可继续，或租约已过期的运行中任务能尝试启动。
      if (!["queued", "ready", "running"].includes(task.status))
        throw new HumanConflict("当前任务不能恢复。");
      // 租约仍有效表示可能已有执行者，拒绝重复启动。
      if (task.status === "running" && Date.parse(task.leaseUntil) > Date.now())
        throw new HumanConflict("任务仍在执行；不能重复启动。");
      // 节点已开始但结果未保存，无法判断外部调用是否完成；保守停止，避免重放。
      if (task.snapshot?.phase === "inflight") {
        task.status = "interrupted";
        task.error =
          "外部调用结果不确定；为避免重复执行，不自动重放。请新建任务。";
        return { actor: "system", action: "interrupted", detail: {} };
      }
      // 抢占执行权并设置租约：总执行时限外再留 5 秒缓冲。
      task.status = "running";
      task.owner = owner;
      task.leaseUntil = new Date(
        Date.now() + this.timeoutMs + 5000,
      ).toISOString();
      return { actor: "system", action: "started", detail: {} };
    });
    // interrupted 已持久化，无需启动后台执行。
    if (task.status !== "running") return;
    // 不等待研究完成，调用方可以立即返回；最终状态由后台任务写入数据库。
    // 末尾 catch 防止持久化失败等未捕获异常变成未处理的 Promise 拒绝。
    const work = this.execute(task.id, key, owner, task.question, task.snapshot)
      .catch(() => undefined)
      .finally(() => this.active.delete(id));
    this.active.set(id, work);
  }
  // 执行一次运行片段：遇到审批会结束本次调用，批准后再从快照继续。
  private async execute(
    id: string,
    key: string,
    owner: string,
    question: string,
    resume: LoopSnapshot | null,
  ) {
    // previous 是已累计的执行时间；暂停等待人工审批的时间不计入。
    const started = Date.now(),
      previous = resume?.elapsedMs ?? 0;
    // 只分配剩余时间；至少传 1ms，已耗尽的情况在进入图之前显式拒绝。
    const deadline = createDeadline(
      new AbortController().signal,
      Math.max(1, this.timeoutMs - previous),
    );
    // 每个节点运行前保存 inflight：标记即将执行，确保崩溃后不会盲目重放。
    const save: LoopHooks["before"] = async (node, state, budget) => {
      await this.store.change(id, key, (task) => {
        // 每次写入都核对 owner，旧执行者不能覆盖已被其他执行者接管的任务。
        if (task.status !== "running" || task.owner !== owner)
          throw new HumanConflict("任务执行权已失效。");
        // 保存节点输入、预算和累计耗时；next 指向即将开始的节点。
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
    const emit: import("../mcp/client.js").ToolEventSink = async (
      type,
      detail,
    ) => {
      await this.store.change(id, key, (task) => {
        if (task.owner !== owner || task.status !== "running")
          throw new HumanConflict("执行权已失效");
        if (type === "REPORT_PREVIEW" && typeof detail.report === "string")
          task.report = detail.report;
        return { actor: "system", action: type, detail };
      });
    };
    try {
      // 人工批准不会重置执行时限，耗尽后不能再进行检索或模型调用。
      if (previous >= this.timeoutMs)
        throw new Error("Execution time exhausted");
      // 调用同一张研究图。此模式通过查询任务和审计展示状态，暂不保存 SSE 流。
      const report = await runResearchLoop(
        question,
        this.provider,
        deadline.signal,
        async () => {},
        this.local,
        this.tools,
        emit,
        this.endpoints ? createRemoteAgents(this.endpoints, emit) : null,
        // 新预算对象会由图根据 resume 恢复累计数值。
        new ResearchBudget(),
        {
          ...(resume ? { resume } : {}),
          before: save,
          // 节点成功后保存合并后的状态及下一节点；规划后准备取证时要求人工批准。
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
              // 快照和审批在同一事务中保存，避免出现有审批却没有可恢复状态。
              if (pause) {
                task.status = "pending";
                // MCP 属工具访问审批；本地检索按首轮计划或补充计划区分。
                task.approval = this.store.approval(
                  ["mcp", "web"].includes(state.plan.action)
                    ? "tool"
                    : state.round
                      ? "plan_adjustment"
                      : "plan",
                  question,
                  state.plan.query,
                  state.plan.questions,
                  `${state.plan.reason}${state.plan.action === "web" ? "；将向 Brave 发送查询并读取搜索摘要（非网页全文）。" : state.plan.action === "mcp" ? "；将通过 MCP 子进程读取可信目录中的一份本地文档，不联网、不写入。" : "；批准后执行本地检索。"}`,
                );
              }
              return {
                actor: "system",
                action: pause ? "approval_requested" : "node_completed",
                detail: { node, approval: task.approval },
              };
            });
            // 事务提交后才暂停；批准后将从快照中的 research 节点继续。
            if (pause) throw new Paused();
          },
        },
        this.web,
      );
      // 图正常结束后再次确认执行权，再原子保存完成状态和报告。
      await this.store.change(id, key, (task) => {
        if (task.owner !== owner || task.status !== "running")
          throw new HumanConflict("任务状态已改变。");
        task.status = "completed";
        task.report = report;
        return { actor: "system", action: "completed", detail: {} };
      });
    } catch (error) {
      // 正常暂停保持 pending；其他错误标记失败，且不发布未经验证的报告。
      if (!(error instanceof Paused))
        await this.store.change(id, key, (task) => {
          // 如果执行权已失效，不覆盖其他执行者写入的状态。
          if (task.status !== "running" || task.owner !== owner) return;
          task.status = "failed";
          const code =
            error instanceof ModelError
              ? error.code
              : deadline.signal.aborted
                ? "MODEL_TIMEOUT"
                : "EXECUTION_FAILED";
          const reason =
            error instanceof ModelError
              ? ({
                  "Model output reached its token limit.":
                    "模型输出达到单次 token 上限。",
                  "The report contains missing or unknown chunk citations. Streamed text is an unvalidated draft.":
                    "研究草稿缺少引用，或引用了不存在的片段。",
                  "A finding cites an unknown source or a quote absent from the source.":
                    "分析中的来源编号或逐字引文与证据不匹配。",
                  "The model returned invalid structured output.":
                    "模型未返回符合约定的 JSON 结构。",
                }[error.message] ?? "模型调用或输出校验失败。")
              : "研究执行失败。";
          task.error = deadline.signal.aborted
            ? "执行超时或取消。"
            : `${code}：${reason}未发布未验证报告。`;
          return {
            actor: "system",
            action: "failed",
            detail: { message: task.error, code, node: task.snapshot?.next },
          };
        });
    } finally {
      // 无论完成、失败或暂停，都清理本次 deadline 的计时资源。
      deadline.dispose();
    }
  }
}
