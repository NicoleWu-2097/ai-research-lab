# Milestone 8：真实 A2A 服务

研究执行者和 Critic 分别运行在独立进程中，Coordinator 使用官方 `@a2a-js/sdk 1.3.0`，通过 A2A 1.0 JSON-RPC/SSE 发现并调用它们。角色可独立配置模型和时限，M7/M8 模式保留一次修订预算；当前默认 [M9 循环](milestone9.md) 会根据缺证反馈重新取证。设 RESEARCH_LOOP_ENABLED=false 可独立验证 M8。

## 运行

沿用 API 的模型配置，在三个终端分别运行：

```bash
MODEL_TIMEOUT_MS=300000 pnpm --filter @research-lab/api a2a:researcher
MODEL_TIMEOUT_MS=300000 pnpm --filter @research-lab/api a2a:critic
A2A_ENABLED=true MODEL_TIMEOUT_MS=300000 pnpm dev
```

默认地址为 `http://127.0.0.1:4101`、`http://127.0.0.1:4102`。Agent Card 位于 `/.well-known/agent-card.json`，JSON-RPC 位于 `/a2a`。更换端口时，在角色进程设置 `A2A_PORT`，并对应设置 API 的 `A2A_RESEARCHER_URL`、`A2A_CRITIC_URL`。每个进程可单独覆盖原有 `LLM_PROVIDER`、模型和 `MODEL_TIMEOUT_MS` 配置。

A2A 默认关闭；开启时要求 `AGENTIC_RAG_ENABLED`、`MULTI_AGENT_ENABLED` 均开启。关闭 `A2A_ENABLED` 回到 M7 进程内角色。

## 演示与验收

启动两个角色后，可独立运行 Coordinator 演示（读取仓库 ADR，不需要数据库）：

```bash
pnpm --filter @research-lab/api a2a:demo
pnpm --filter @research-lab/api a2a:demo --cancel
```

页面可提交“请依据本地资料解释 PostgreSQL 和 pgvector 的选型理由，每条理由引用来源。”，在“研究过程”观察发现、远程任务 ID、进度、产物及终态。问候和证据不足路径仍不委派远程角色。

协议测试使用两个真实子进程和官方 SDK，仅替换模型执行：

```bash
pnpm --filter @research-lab/api exec vitest run test/a2a.test.ts
```

## 行为边界

- 每次委派创建一个远程任务：`submitted → working → artifact → completed`；异常为 `failed`，取消为 `canceled`。修订会创建新任务。
- Coordinator 的总任务与角色子任务 ID 分开；A2A 负责跨进程交互，LangGraph 继续负责取证、审查顺序和发布。
- 只读发现/查询最多重试一次。断流后查询同一任务；不自动重发提交。拿不到任务 ID 时明确失败，远端最终受自身时限限制。
- Coordinator 取消或超时会尝试取消已知远程任务，取消请求另有 1.5 秒时限；网络断开时无法保证即时停止。
- 角色只接收证据快照，没有检索工具；输入和产物都有 schema/大小限制，主 API 再验引用和审查结果。
- 服务仅绑定 `127.0.0.1`，拒绝浏览器 Origin；客户端仅接受显式配置的回环地址和匹配的 Card，不跟随重定向。无远程认证或多用户隔离，勿公开端口。
- 子任务保存在各服务内存中，可查询，重启后丢失；当前无持久恢复、自动清理、推送通知或文件传输。长时间开发会话可重启角色释放任务记录。
- A2A 不改善模型本身的语义准确率，沿用 M7 的 Critic 局限。

协议依据：[官方 SDK](https://github.com/a2aproject/a2a-js)、[A2A 1.0 规范](https://a2a-protocol.org/v1.0.0/specification/)。

验收记录：80 项自动测试通过；类型、lint、格式和构建通过。真实 Ollama 双进程演示、远程取消及主 API/PostgreSQL 的完整 HTTP 链路均通过。测试服务已关闭，按上述命令启动即可复验。
