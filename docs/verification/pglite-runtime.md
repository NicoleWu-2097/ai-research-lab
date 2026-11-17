# 验收记录：PGlite 作为运行数据库

日期：2026-11-17。环境：Windows，Node v24.19.0，pnpm 11.22.0。本机没有 `docker`、`psql` 与运行的 PostgreSQL，数据库改由 API 进程内的 PGlite 承担。

## 配置

```bash
DATABASE_DRIVER=pglite
PGLITE_DATA_DIR=.pglite
RAG_ENABLED=true
```

`.pglite/` 已在 `.gitignore` 中。

## 跑过的步骤

建索引：

```bash
cd apps/api && npx tsx src/rag/ingest.ts
# {"documents":4,"duplicates":0,"chunks":6}
```

启动 API：

```bash
cd apps/api && PORT=3123 npx tsx src/index.ts
# {"event":"SERVER_STARTED",...,"ragEnabled":true,"humanEnabled":true,...}
```

```bash
curl http://127.0.0.1:3123/api/health
# {"status":"ok","service":"api","humanEnabled":true}

curl http://127.0.0.1:3123/api/rag/health
# {"status":"ready","compatible":true,"indexedAt":"2026-11-17 10:34:13.45+08","chunks":6}
```

Agent 端到端（网关对话模型 + 网关嵌入 + PGlite 检索）：

```bash
curl -X POST http://127.0.0.1:3123/api/agent/execute \
  -H 'content-type: application/json' \
  -d '{"message":"这个项目为什么选择 PostgreSQL 和 pgvector？请引用知识库片段回答。"}'
```

返回 `taskState`、`output`、`evidences`（4 条）、`trace`（16 个事件）。答案引用了 `【RAG:1】`，对应 `0003-storage-and-protocol-boundaries.md`；trace 事件序列为 `task_started`、`plan_updated`、`tool_started`、`evidence_added`、`tool_completed`、`verification_completed`、`task_completed`。

人工模式持久化任务：

```bash
curl -X POST http://127.0.0.1:3123/api/research/tasks -H 'content-type: application/json' \
  -d '{"message":"对比 pgvector 与专用向量数据库在这类研究助手项目里的取舍","actor":"user"}'
curl http://127.0.0.1:3123/api/research/tasks/<id> -H 'x-research-key: <key>'
curl -X POST http://127.0.0.1:3123/api/research/tasks/<id>/approve \
  -H 'content-type: application/json' -H 'x-research-key: <key>' \
  -d '{"actor":"user","approvalId":"<approvalId>"}'
```

审计事件依次为 `created`、`started`、`intent_started`、`intent_decided`、`node_started`、`LOOP_PLAN`、`approval_requested`、`approved`、`RETRIEVAL_STARTED`、`RETRIEVAL_COMPLETED`、`node_completed`、`LOOP_ANALYSIS`、`SOURCES_COLLECTED`、`REPORT_PREVIEW`、`CITATIONS_UNVERIFIED`、`REPORT_UNVERIFIED`、`RESEARCH_STOPPED`、`LOOP_REPORT`、`LOOP_COMPLETED`、`completed`。检索未降级。

任务以 `completed` 结束，报告被标记为「待核验报告」：这一轮的草稿没有产生有效引用，评审按规则拒绝放行，报告内容保留模型推测提示。该判定由模型输出决定，与数据库无关。

## 测试覆盖

`test/database.test.ts` 覆盖：数据在关闭与重开后仍在、事务内可使用 vector 扩展、并发事务在单连接上串行执行且结果正确、未设置驱动时仍走 postgres。

## 已知限制

PGlite 只有一条连接，`createDatabase` 把语句与事务排成队列依次执行；写入与读取不会交错，但长事务会阻塞其他访问。数据目录同一时间只能被一个进程打开，`rag:ingest`、`rag:reindex` 需要在 API 停止后执行。

## 未验证

多进程同时访问同一数据目录（不支持）、大语料下的检索延迟、Windows 之外的路径行为。
