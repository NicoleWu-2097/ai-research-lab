# Milestone 5：本地 RAG

> 说明：本页是历史里程碑记录，下面仍按当时的本地 Ollama 方案书写。当前默认已改为外部嵌入服务，见 [ADR 0004](decisions/0004-external-embedding.md)。

固定流程：问题 → embedding → pgvector 检索 → 带引用的流式报告。启用 RAG 时取代 M4 的全文选择流程；未启用时仍可使用 MCP。自主路由留到 M6。

当前版本默认使用 [M6 自主路由](milestone6.md)；设 `AGENTIC_RAG_ENABLED=false` 可验证本页描述的 M5 固定流程。

## 启动

本机已安装 Docker CLI、Compose 和 Colima。重启机器后先运行 `colima start`；停止虚拟机用 `colima stop`。虚拟机配置为 2 CPU、2 GiB 内存、20 GiB 磁盘上限。

本机 `apps/api/.env` 已启用本地 RAG，容器数据库已摄取 3 份 ADR（4 个片段）。直接运行 `pnpm dev` 即可使用。

需要 Docker Compose（或已有 PostgreSQL + pgvector）、Ollama。仓库根目录执行：

```bash
docker compose up -d --wait
ollama pull embeddinggemma
```

在 `apps/api/.env` 保留生成模型配置，并加入：

```dotenv
RAG_ENABLED=true
DATABASE_URL=postgresql://research:local-research@localhost:5432/research
EMBEDDING_PROVIDER=ollama
EMBEDDING_MODEL=embeddinggemma
EMBEDDING_DIMENSIONS=768
```

随后在仓库根目录执行：

```bash
pnpm --filter @research-lab/api rag:ingest
pnpm dev
```

`docker compose stop` 停止数据库并保留数据卷；下次用 `docker compose up -d --wait` 恢复。

## 外部 PostgreSQL

不启动 Compose，直接在 `apps/api/.env` 配置已有服务：

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
DATABASE_SSL_MODE=verify-full
# 服务商提供私有 CA 时：
# DATABASE_SSL_CA_FILE=/absolute/path/to/provider-ca.pem
```

密码特殊字符需 URL 编码。TLS 校验服务端证书及主机名；也可以省略 `DATABASE_SSL_MODE`，使用服务商连接串的 TLS 参数。两种配置方式不能混用。连接池与 SQL 适配器相同，无需改业务代码。

服务需支持 pgvector。管理员可预先执行 `CREATE EXTENSION IF NOT EXISTS vector;`；摄取账号需要建表、读写及表锁权限。使用独立数据库或 schema，当前 `rag_*` 表只存一份资料集，重新摄取会替换它。切换服务后重新摄取并重启 API。

默认摄取 `docs/decisions`。修改文档、资料目录、embedding 模型或维度后重新运行 `rag:ingest`。更换配置后重启 API。`RAG_DOCUMENT_ROOT` 可指定资料目录；相对路径以 `apps/api` 为基准。

## 验证

开发侧已通过真实 PostgreSQL/Ollama HTTP 链路及 Edge 页面验收：研究完成、引用编号与展开的 ADR 原文/行号对应。重新摄取测试覆盖修改、删除和空资料集；空资料集会清空索引并返回证据不足。

```bash
curl http://localhost:3001/api/rag/health
curl http://localhost:3001/api/rag/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"question":"为什么选择 PostgreSQL 和 pgvector？"}'
```

健康检查应返回 `ready` 和片段数，它检查数据库及索引配置，不探测模型在线状态。页面提问同一问题，检查报告中的 `[RAG:1]` 与“检索来源”的文件、行号、原文片段对应。流式草稿在最终校验失败时不会标为完成。无命中时明确返回证据不足。

真实 PostgreSQL 集成测试（创建并清理独立测试 schema，保留业务表）：

```bash
TEST_DATABASE_URL=postgresql://research:local-research@localhost:5432/research \
  pnpm --filter @research-lab/api exec vitest run test/postgres.test.ts
```

测试账号需要建 schema 权限及已安装的 pgvector。未设置 `TEST_DATABASE_URL` 时，普通测试会跳过这组外部数据库测试。

没有 Docker 时可运行 `pnpm --filter @research-lab/api rag:smoke`：读取同一模型配置，使用临时 PGlite + pgvector 和真实模型完成摄取、研究与引用检查，退出后丢弃数据库。这不验证外部 PostgreSQL 的连接与部署。

## 边界

- 单资料集，最多 30 个符合 ASCII 文件名规则的 `.md`，每份最多 24 KB；不递归、不跟随符号链接。按文件原始字节 SHA-256 去重，重复内容保留排序首个文件。
- 原样解析 Markdown 文本，900 个 UTF-16 单位分块、120 重叠；保留字符区间 `[start,end)`、行号、原文哈希及摄取/检索时间。暂不解析 PDF，也不按标题或 token 分块。
- 独立 embedding 配置支持 Ollama/OpenAI；维度必须等于模型原生输出维度。OpenAI 复用 `OPENAI_API_KEY`。更换同名模型权重也应重新摄取。
- 最多召回 4 段，余弦相似度默认至少 0.4（`RAG_MIN_SCORE`），不是置信概率。小资料集使用精确检索，无 HNSW、混合检索或 reranker。
- 全部 embedding 成功后事务替换整个索引，删除的文件随重新摄取移出索引；失败保留旧快照。不要并行运行不同资料集的摄取命令。
- 引用校验只保证编号对应真实检索片段，不证明结论被证据支持；仍需人工核验。任务和引用事件暂不持久化。

实现：`apps/api/src/rag`；确定性 SQL/引用测试：`apps/api/test/rag.test.ts`；真实模型冒烟脚本：`apps/api/test/rag-smoke.ts`。
