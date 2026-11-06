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
}
export interface HumanTask {
  id: string;
  question: string;
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
      question,
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
        [id, actor, JSON.stringify({ clarify })],
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
    const audit = await this.db.query(
      "SELECT seq,actor,action,detail,created_at FROM human_audit WHERE task_id=$1 ORDER BY seq",
      [id],
    );
    return { ...rows[0].data, audit: audit.rows };
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
      const task = rows[0].data;
      const event = work(task);
      if (event) {
        task.updatedAt = new Date().toISOString();
        await sql.query("UPDATE human_tasks SET data=$2::jsonb WHERE id=$1", [
          id,
          JSON.stringify(task),
        ]);
        await sql.query(
          "INSERT INTO human_audit(task_id,actor,action,detail) VALUES($1,$2,$3,$4::jsonb)",
          [id, event.actor, event.action, JSON.stringify(event.detail)],
        );
      }
      return task;
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
      if (approve && value !== undefined) {
        if (approval.kind === "clarification") task.question = value;
        else if (task.snapshot) {
          const queryKey = `${task.snapshot.state.plan.action}:${value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase()}`;
          if (task.snapshot.state.queries.includes(queryKey))
            throw new HumanConflict("调整后的查询与已执行查询重复。");
          task.snapshot.state.plan.query = value;
        }
      }
      task.status = approve ? "ready" : "rejected";
      task.approval = null;
      return {
        actor,
        action: approve ? "approved" : "rejected",
        detail: { approval, value: value ?? null },
      };
    });
  }
}
