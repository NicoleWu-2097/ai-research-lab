import { nextEvidence } from "./continuation.js";
import { savedReport } from "../research/report.js";
import {
  newTurn,
  contentKind,
  summarizeTitle,
  type TurnMetadata,
  type ContentEventMetadata,
} from "./contract.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "../rag/store.js";
import type { LoopSnapshot } from "../research/loop.js";
export type Status =
  | "queued"
  | "running"
  | "pending"
  | "ready"
  | "completed"
  | "failed"
  | "rejected"
  | "expired"
  | "interrupted";
export interface Approval {
  id: string;
  kind: "clarification" | "plan" | "plan_adjustment" | "tool";
  question: string;
  query: string;
  questions: string[];
  reason: string;
  expiresAt: string;
  goal?: string;
  serves?: string;
}
export interface HumanTask {
  id: string;
  title?: string;
  question: string;
  turn: TurnMetadata;
  status: Status;
  snapshot: LoopSnapshot | null;
  approval: Approval | null;
  report: string;
  error: string;
  owner: string;
  leaseUntil: string;
  createdAt: string;
  updatedAt: string;
  configKey: string;
  history?: {
    turn: TurnMetadata;
    question: string;
    report: string;
    snapshot: LoopSnapshot | null;
    status: Status;
    completedAt: string;
    error?: string;
  }[];
}
// JSON 存储按读取时补齐旧字段；确定性 ID 保证只读轮询不会改变身份。
function normalizeTask(task: HumanTask): HumanTask {
  let previousReport: string | null = null;
  let previousRevision: number | null = null;
  for (const [index, turn] of (task.history ?? []).entries()) {
    turn.turn ??= newTurn(
      task.id,
      index + 1,
      turn.question,
      previousReport,
      previousRevision,
    );
    if (turn.report && turn.turn.report.quality === "none") {
      turn.turn.report.quality = "unreviewed";
      turn.turn.report.revision = 1;
    }
    if (turn.report) {
      previousReport = turn.turn.report.id;
      previousRevision = turn.turn.report.revision;
    }
  }
  task.turn ??= newTurn(
    task.id,
    (task.history?.length ?? 0) + 1,
    task.question,
    previousReport,
    previousRevision,
  );
  if (task.report && task.turn.report.quality === "none") {
    task.turn.report.quality = "unreviewed";
    task.turn.report.revision = 1;
  }
  task.title ??= summarizeTitle(task.history?.[0]?.question ?? task.question);
  return task;
}
export interface AuditEvent extends Record<string, unknown> {
  seq: string | number;
  actor: string;
  action: string;
  detail: Record<string, unknown> & { _event?: ContentEventMetadata };
  created_at: string | Date;
}
export class HumanConflict extends Error {}
const hash = (key: string) => createHash("sha256").update(key).digest("hex");
export class HumanStore {
  constructor(
    readonly db: Database,
    readonly approvalMs = 86400000,
  ) {}
  async initialize() {
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS human_tasks(id uuid PRIMARY KEY, key_hash text NOT NULL, data jsonb NOT NULL)`,
    );
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS human_audit(seq bigserial PRIMARY KEY, task_id uuid NOT NULL REFERENCES human_tasks(id), actor text NOT NULL, action text NOT NULL, detail jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    );
  }
  async create(
    question: string,
    actor: string,
    clarify: boolean,
    configKey: string,
  ) {
    const id = randomUUID(),
      key = randomBytes(32).toString("hex"),
      now = new Date().toISOString();
    const task: HumanTask = {
      id,
      title: summarizeTitle(question),
      question,
      turn: newTurn(id, 1, question),
      status: clarify ? "pending" : "queued",
      snapshot: null,
      approval: clarify
        ? this.approval(
            "clarification",
            question,
            "",
            [],
            "请确认研究范围并补充必要背景。",
          )
        : null,
      report: "",
      error: "",
      owner: "",
      leaseUntil: now,
      createdAt: now,
      updatedAt: now,
      configKey,
    };
    await this.db.transaction(async (sql) => {
      await sql.query("INSERT INTO human_tasks VALUES($1,$2,$3::jsonb)", [
        id,
        hash(key),
        JSON.stringify(task),
      ]);
      await sql.query(
        "INSERT INTO human_audit(task_id,actor,action,detail) VALUES($1,$2,'created',$3::jsonb)",
        [
          id,
          actor,
          JSON.stringify({
            clarify,
            message: question,
            _event: { roundId: task.turn.id, kind: "user_message" },
          }),
        ],
      );
    });
    return { task, key };
  }
  approval(
    kind: Approval["kind"],
    question: string,
    query: string,
    questions: string[],
    reason: string,
  ): Approval {
    return {
      id: randomUUID(),
      kind,
      question,
      query,
      questions,
      reason,
      expiresAt: new Date(Date.now() + this.approvalMs).toISOString(),
    };
  }
  async read(id: string, key: string) {
    await this.change(id, key, (task) => {
      if (
        task.status === "pending" &&
        task.approval &&
        Date.parse(task.approval.expiresAt) <= Date.now()
      ) {
        task.status = "expired";
        const fallback = savedReport(task);
        task.report = fallback.report;
        task.turn.report.quality = fallback.quality;
        task.turn.stop = {
          code: "cancelled",
          message: "审批已过期，未执行待批准操作。",
        };
        return {
          actor: "system",
          action: "expired",
          detail: { approvalId: task.approval.id },
        };
      }
    });
    const { rows } = await this.db.query<{ data: HumanTask }>(
      "SELECT data FROM human_tasks WHERE id=$1 AND key_hash=$2",
      [id, hash(key)],
    );
    if (!rows[0]) throw new HumanConflict("任务不存在或访问密钥不正确。");
    const audit = await this.db.query<AuditEvent>(
      "SELECT seq,actor,action,detail,created_at FROM human_audit WHERE task_id=$1 ORDER BY seq",
      [id],
    );
    let round = 1;
    return {
      ...normalizeTask(rows[0].data),
      audit: audit.rows.map((event) => {
        if (event.action === "followup") round++;
        return {
          ...event,
          id: `${id}:event:${event.seq}`,
          roundId: event.detail._event?.roundId ?? `${id}:turn:${round}`,
          kind:
            event.detail._event?.kind ??
            contentKind(event.action, event.detail),
        };
      }),
    };
  }
  async change(
    id: string,
    key: string,
    work: (
      task: HumanTask,
    ) => { actor: string; action: string; detail: unknown } | void,
  ) {
    return this.db.transaction(async (sql) => {
      const { rows } = await sql.query<{ data: HumanTask }>(
        "SELECT data FROM human_tasks WHERE id=$1 AND key_hash=$2 FOR UPDATE",
        [id, hash(key)],
      );
      if (!rows[0]) throw new HumanConflict("任务不存在或访问密钥不正确。");
      const task = normalizeTask(rows[0].data);
      const previousReport = task.report;
      const previousRound = task.turn.id;
      const event = work(task);
      if (event) {
        if (task.turn.id === previousRound && task.report !== previousReport) {
          task.turn.report.revision++;
          if (task.turn.report.quality === "none")
            task.turn.report.quality = "unreviewed";
        }
        task.updatedAt = new Date().toISOString();
        await sql.query("UPDATE human_tasks SET data=$2::jsonb WHERE id=$1", [
          id,
          JSON.stringify(task),
        ]);
        await sql.query(
          "INSERT INTO human_audit(task_id,actor,action,detail) VALUES($1,$2,$3,$4::jsonb)",
          [
            id,
            event.actor,
            event.action,
            JSON.stringify({
              ...(event.detail as Record<string, unknown>),
              _event: {
                roundId: task.turn.id,
                kind: contentKind(
                  event.action,
                  event.detail as Record<string, unknown>,
                ),
              },
            }),
          ],
        );
      }
      return task;
    });
  }
  async followup(
    id: string,
    key: string,
    question: string,
    actor: string,
    continuation = false,
  ) {
    return this.change(id, key, (task) => {
      if (["running", "pending", "queued", "ready"].includes(task.status))
        throw new HumanConflict("请先完成当前轮次。");
      if (continuation) {
        if (!task.report.trim())
          throw new HumanConflict("当前轮次没有报告，请先完成一次研究。");
        const evidence =
          nextEvidence(task.report) ||
          task.snapshot?.state.analysis.unresolved.join("；") ||
          task.snapshot?.state.issues.join("；") ||
          "";
        if (!evidence.trim())
          throw new HumanConflict(
            "上一轮报告没有下一步所需证据，请直接输入要补充研究的问题。",
          );
        question = [
          "继续科研：围绕上一轮所需证据开展新的检索并生成新报告，不要只改写或总结旧报告。",
          `原始课题：${(task.history?.[0]?.question ?? task.question).slice(0, 600)}`,
          `上一轮下一步所需证据（仅作检索线索，尚未经核验）：\n${evidence.slice(0, 4000)}`,
          `用户补充指令：${question || "无，请优先补齐上述证据缺口。"}`,
        ].join("\n\n");
      }
      const previous = {
        turn: structuredClone(task.turn),
        question: task.question,
        report: task.report,
        snapshot: task.snapshot,
        status: task.status,
        completedAt: task.updatedAt,
        error: task.error,
      };
      task.history = [...(task.history ?? []), previous];
      task.turn = newTurn(
        task.id,
        task.history.length + 1,
        question,
        task.report ? task.turn.report.id : task.turn.basedOnReportId,
        task.report
          ? task.turn.report.revision
          : task.turn.basedOnReportRevision,
      );
      task.turn.continuation = continuation;
      task.question = question;
      task.snapshot = null;
      task.report = "";
      task.error = "";
      task.approval = null;
      task.status = "ready";
      return {
        actor,
        action: "followup",
        detail: { question, message: question, round: task.history.length + 1 },
      };
    });
  }
  async decide(
    id: string,
    key: string,
    approvalId: string,
    actor: string,
    approve: boolean,
    value?: string,
  ) {
    await this.read(id, key);
    return this.change(id, key, (task) => {
      if (
        task.status !== "pending" ||
        task.approval?.id !== approvalId ||
        Date.parse(task.approval.expiresAt) <= Date.now()
      )
        throw new HumanConflict("审批已处理、已过期或版本不匹配。");
      const approval = task.approval;
      if (
        approve &&
        approval.kind === "clarification" &&
        task.turn.intent === "clarify" &&
        !value?.trim()
      )
        throw new HumanConflict("请填写澄清内容后再继续。");
      if (approve && value !== undefined) {
        if (approval.kind === "clarification") {
          task.question = value;
          task.turn.goal = value;
        } else if (task.snapshot) {
          const queryKey = `${task.snapshot.state.plan.action}:${value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()}`;
          if (task.snapshot.state.queries.includes(queryKey))
            throw new HumanConflict("调整后的查询与已执行查询重复。");
          task.snapshot.state.plan.query = value;
          task.turn.query = value;
        }
      }
      task.status = approve ? "ready" : "rejected";
      if (!approve) {
        const fallback = savedReport(task);
        task.report = fallback.report;
        task.turn.report.quality = fallback.quality;
        task.turn.stop = {
          code: "cancelled",
          message: "用户拒绝本次计划，未继续执行。",
        };
      }
      task.approval = null;
      return {
        actor,
        action: approve ? "approved" : "rejected",
        detail: { approval, value: value ?? null },
      };
    });
  }
  async delete(id: string, key: string) {
    return this.db.transaction(async (sql) => {
      const { rows } = await sql.query<{ id: string }>(
        "SELECT id FROM human_tasks WHERE id=$1 AND key_hash=$2 FOR UPDATE",
        [id, hash(key)],
      );
      if (!rows[0]) throw new HumanConflict("任务不存在或访问密钥不正确。");
      await sql.query("DELETE FROM human_audit WHERE task_id=$1", [id]);
      await sql.query("DELETE FROM human_tasks WHERE id=$1 AND key_hash=$2", [
        id,
        hash(key),
      ]);
      return { deleted: true, id };
    });
  }
}
