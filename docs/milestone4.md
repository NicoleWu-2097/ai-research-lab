# Milestone 4：MCP 资料工具

运行 `pnpm dev`，在页面提问：**“本项目为什么选择 PostgreSQL + pgvector？请引用本地决策文档。”** 工具活动应显示发现、列表、读取；报告可引用 `0003-storage-and-protocol-boundaries.md`。需要已配置支持结构化输出的模型。

默认 `MCP_ENABLED=true`，资料目录为仓库 `docs/decisions`。可在 `apps/api/.env` 设置 `MCP_DOCUMENT_ROOT=/绝对路径`；设 `MCP_ENABLED=false` 可使用仅模型知识的路径。修改后重启 API。不需要另开 MCP 服务，API 为每个研究请求启动并关闭一个 stdio 子进程。

```text
Hono → LangGraph collect_sources → 官方 MCP Client
                                  ↕ JSON-RPC / stdio
                              独立 MCP Server → 指定目录
     → research 节点（带资料的模型生成）→ SSE → 页面
```

| 工具 | 权限与限制 |
| --- | --- |
| `list_documents` | 仅列出根目录内最多 30 个 `.md` 文件，不递归 |
| `read_document` | 仅接受文件 ID；单次最多 24,000 字节；拒绝路径穿越、符号链接与非普通文件 |

使用官方 `@modelcontextprotocol/client` / `server` 2.3.0，完成真实握手、`listTools`、`callTool`。每任务最多一次列表、一次读取；协议请求超时 10 秒，总请求沿用 `MODEL_TIMEOUT_MS`，取消后关闭子进程。工具出错会发 `TOOL_FAILED` 并使任务失败，不伪装成未找到资料。模型密钥不传给工具进程；stdout 专用于协议。

**两个不同层次：** 模型通过现有 `structuredOutput` 从已列出的 ID 中选择一份或 `none`；宿主校验选择、执行工具，MCP 负责工具协议。本阶段未加入模型原生 function calling 或 ReAct 循环。文档读取也未做 embedding、索引或 RAG。

文档被作为不可信数据送入提示词，工具结果带 ID、SHA-256 和读取时间；页面展示工具活动和来源 ID。提示词隔离并不能彻底消除注入风险，读取成功也不等于报告结论已核验。本服务是受信任的本地代码，目录限制由应用实施，尚无 OS 沙箱；请只把准备供研究使用的资料放进指定目录。

协议测试：`pnpm --filter @research-lab/api exec vitest run test/mcp.test.ts`。测试会启动真实子进程，以临时语料验证发现/读取、路径限制、Agent 选择、跳过、失败和取消。完整检查沿用 README。
