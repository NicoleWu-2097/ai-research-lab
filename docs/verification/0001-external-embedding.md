# 验收记录：外部嵌入服务与无 Ollama 运行

日期：2026-11-17。分支：集成分支 `spec/0001-external-embedding`。

环境：Windows，Node v24.19.0，pnpm 11.22.0。本机没有 `ollama`、`psql`、`docker` 命令，也没有 `apps/api/.env`，没有可用的 `EMBEDDING_API_KEY`。

## 跑过的命令与结果

### 类型检查

```bash
pnpm typecheck
```

结果：3 个包全部通过（`@research-lab/api`、`@research-lab/cli`、`@research-lab/web`）。

### 测试

```bash
cd apps/api && npx vitest run
```

结果：`Test Files 1 failed | 18 passed | 2 skipped (21)`，`Tests 5 failed | 168 passed | 3 skipped (176)`。

- 5 个失败全部在 `test/mcp.test.ts`，原因是 Windows 下创建符号链接权限不足，属于本机基线，与本次改动无关。
- 2 个跳过文件 `test/postgres.test.ts`、`test/human-postgres.test.ts` 需要 `TEST_DATABASE_URL`，本机没有 PostgreSQL；这些文件里的 3 个测试同样跳过。
- 其余 18 个测试文件通过，覆盖嵌入配置解码、上传、检索、稀疏降级、重灌、研究循环与 Agent 运行时降级事件。

### Lint

```bash
pnpm lint
```

结果：通过，无输出。

### 格式检查

```bash
npx prettier --check <本次改动的文件>
```

结果：`All matched files use Prettier code style!`

### 构建

```bash
pnpm build
```

结果：3 个包全部成功，`apps/api` 编译通过，`apps/web` 完成 Vite 构建。

## 没有 Ollama 的启动日志

本机没有安装 Ollama。启动命令在 `apps/api` 目录执行：

```bash
OLLAMA_DISABLED=true EMBEDDING_PROVIDER=voyage EMBEDDING_MODEL=voyage-4 EMBEDDING_DIMENSIONS=1024 \
DATABASE_URL=postgresql://research:local-research@localhost:5432/research \
MCP_ENABLED=false RAG_ENABLED=true PORT=3987 npx tsx src/index.ts
```

启动日志：

```json
{"event":"SERVER_STARTED","service":"api","port":3987,"modelProvider":"unconfigured","model":null,"embeddingProvider":"voyage","embeddingModel":"voyage-4","embeddingBaseUrl":"https://api.voyageai.com/v1","mcpEnabled":false,"ragEnabled":true,"multiAgentEnabled":true,"endpoints":null,"researchLoopEnabled":true,"humanEnabled":false,"a2aEnabled":false,"agenticEnabled":true}
```

日志确认生效的嵌入服务是 Voyage 的默认地址，启动断言在无 Ollama 配置下通过。

同一进程的健康检查：

```bash
curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:3987/api/health
# {"status":"ok","service":"api"}
# HTTP 200

curl -s -w "\nHTTP %{http_code}\n" http://127.0.0.1:3987/api/rag/health
# {"status":"unavailable"}
# HTTP 503
```

`/api/health` 返回 200。`/api/rag/health` 返回 503，因为本机没有 PostgreSQL 可连接。

## 重灌命令

```bash
cd apps/api && OLLAMA_DISABLED=true EMBEDDING_PROVIDER=voyage EMBEDDING_MODEL=voyage-4 EMBEDDING_DIMENSIONS=1024 \
DATABASE_URL=postgresql://research:local-research@localhost:5432/research npx tsx src/rag/reindex.ts
```

结果：退出码 1，stderr 输出 `RAG reindex failed; check database, documents, embedding service and dimensions.`。原因同样是本机没有 PostgreSQL，脚本在读取旧索引配置时连接失败，没有写入任何内容。

## 本机无法完成、需要用户机器才能做的项目

以下项目本次没有执行，不能算作已验收：

- 用真实嵌入服务 key 调用外部接口：本机没有 `EMBEDDING_API_KEY`，也没有网络凭证，所以没有发出真实的 embedding HTTP 请求，没有验证 Voyage 与 Jina 的实际返回维度，也没有验证 429 与 5xx 的退避重试在真实服务上的表现。相关请求构造与重试逻辑由 `test/embedding.test.ts` 用本地 fetch 桩覆盖。
- 连接真实 PostgreSQL 并写入 pgvector：本机没有 PostgreSQL 服务，`rag:ingest`、`rag:reindex` 的实际写库与重灌摘要输出都没有跑过。基于 PGlite 的 `test/rag.test.ts`、`test/reindex.test.ts` 覆盖了同一条 SQL 路径，但没有覆盖真实服务的连接参数、权限与 pgvector 扩展安装。
- 完整链路：上传文档、检索、生成带引用的报告与导出。这条链路需要真实嵌入 key 与 PostgreSQL 同时可用，本机无法跑完。
- 用真实旧索引验证重灌摘要：本机没有数据库，`RAG_REINDEX_CONFIGURATION` 事件没有真实输出。索引键的两层解码由 `test/embedding-config.test.ts` 的往返测试与真实两层字符串测试覆盖。

## 自动测试覆盖的验收点

- `test/embedding-config.test.ts`：索引键编码与解码往返；用真实 `createEmbedder` 产出的两层字符串断言 provider、model、维度、分块版本。
- `test/rag.test.ts`：上传、检索、降级标记；`collect` 降级时发出 `RETRIEVAL_DEGRADED`，载荷带 `strategy: "sparse"` 与降级原因。
- `test/reindex.test.ts`：重灌同时处理资料目录与已上传文档；嵌入失败的文档计入降级且不中断；索引键变更后健康检查从不兼容变为兼容。
- `test/loop.test.ts`：研究循环降级事件与报告说明。
- `test/atlas-refactor.test.ts`：Agent 运行时在嵌入服务不可用时走稀疏检索，trace 中出现 `RETRIEVAL_DEGRADED`，工具结果不再重复携带降级元数据。
