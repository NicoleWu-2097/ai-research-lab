# 项目消息与轮次契约

创建和 followup 接口支持 `message`，旧 `question` 仍可用。两者同时提交时必须相同；空输入返回 400。轮次入口先判断意图；总结/编辑直接处理已有报告，研究才进入取证图。

任务的 `turn` 保存：

| 字段 | 含义 |
| --- | --- |
| id / message | 稳定轮次 ID / 接收的原始消息（去除首尾空白） |
| intent / goal / query | agent 意图 / 研究目标 / 当前计划的检索词；未知为 null |
| basedOnReportId / basedOnReportRevision | 本轮沿用的历史报告及修订号 |
| report.id / revision / quality | 本轮报告身份、文本修订号、质量 |

`question` 保留旧流程使用；审批澄清可改变它和 goal，但不覆盖原始 message。query 可以是待审批查询，是否执行应查检索事件。intent 在模型判断后写入；null 表示未判断，不能理解成 research。routing 保存路由/编辑阶段的预算、耗时和执行标记，审批恢复沿用累计值。

`status` 只表示执行状态。质量为 none、unreviewed、reviewed、unverified 或 insufficient；reviewed 仅表示现有程序审查通过，不是事实正确性保证。失败可有 unreviewed 报告。

history 保留每轮的 turn、报告、快照、执行状态和结束时间。旧 JSON 数据读取时补齐确定性轮次 ID，已有报告保守标为 unreviewed；不清库，不凭 completed 推断质量。后续写入会保存补齐字段。

审计/API SSE 保留 seq、action、detail，同时提供稳定 id、roundId、kind。kind 分为 user_message、status、approval、tool、rag、report；客户端按 id 去重，按 roundId 分组。报告按轮次和 revision 识别更新，重复轮询不重复追加。历史未知事件保守归为 status，不猜测原文类型。
