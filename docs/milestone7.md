# Milestone 7：研究执行与 Critic

针对 M6 中“引用存在，但结论可能超出原文”的问题，增加进程内审查流程：

`M6 取证 → Coordinator 委派 → 研究草稿 → Critic → 通过发布 / 修订一次后复审`

## 运行与验收

沿用 [M6](milestone6.md) 的数据库和模型配置，重启 `pnpm dev`。默认 `MULTI_AGENT_ENABLED=true`，需同时启用 `AGENTIC_RAG_ENABLED`；设为 false 回退 M6。未改变资料时无需重新摄取。

提交“这个项目为什么选择 PostgreSQL 和 pgvector？哪些能力只是规划？请引用资料。”，在“研究过程”观察委派、草稿交接、Critic 反馈和最终结果。问候与取证不足不进入审查。

- Coordinator 由程序控制分派、证据快照、预算和发布。
- 研究执行者只使用已取得的证据；Critic 独立接收问题、原文和草稿，无工具权限。
- Critic 检查引用支持、问题覆盖、规划与现状、测量数据及不确定性；反馈最多 6 项。
- 最多修订 1 次、审查 2 次；仍有分歧时返回“审查未通过”，不发布草稿。模型/协议失败则任务失败，可重新提交。
- 草稿不流入报告区，通过后一次发布；等待期间持续显示角色事件。引用有效不等于语义正确，Critic 也可能误判；真实试跑仍出现将 ADR 推断为实施进度的措辞，不能视为事实认证。

M7 比 M6 最多增加 3 次模型调用（2 次审查、1 次修订），仍共用 `MODEL_TIMEOUT_MS`；本地慢模型可设 `300000`。M7 模式的角色复用同一个模型服务，任务不持久化。[M8](milestone8.md) 可显式启用独立 A2A 角色服务。

关键事件：`ROLE_DELEGATED`、`DRAFT_READY`、`CRITIC_REVIEWED`、`COORDINATOR_COMPLETED`。`AGENT_COMPLETED` 表示流程完成；最终结果可能是明确停止，需要结合报告及 outcome 阅读。

验收记录：API 66 项、Web 6 项测试通过，类型、lint、格式和构建通过。真实 Ollama/PostgreSQL HTTP 已完成取证、委派、审查通过和发布；修订及再次否决由 fake agents 验证。
