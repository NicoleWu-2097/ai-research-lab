# HKUST 模型网关

配置在 `apps/api/.env`。网关同时提供聊天与嵌入接口，一个 key 覆盖两边。

## 聊天

请求发到 `https://hkust.azure-api.net/hkust-genai/v1/chat/completions`，Content-Type 为 application/json，认证头为 `api-key`，正文包含 model 与 messages。使用现有 OpenAI 官方 SDK，不额外安装客户端；`OPENAI_BASE_URL` 填到 `/v1`，SDK 自动补路径。

相关变量：

```bash
LLM_PROVIDER=openai
OPENAI_MODEL=gpt-4o-mini
OPENAI_BASE_URL=https://hkust.azure-api.net/hkust-genai/v1
OPENAI_API_STYLE=chat-completions
OPENAI_AUTH_HEADER=api-key
OPENAI_API_KEY=<网关密钥>
```

官方 OpenAI 仍可用 `responses` 与 `bearer`。网关实测支持 `stream: true` 的 SSE 增量返回，也接受 `response_format: {"type":"json_object"}`；应用本身不依赖这两项，各自有非流式与本地 Zod 校验的退路。

## 嵌入

网关的 `/embeddings` 可用，模型选 `text-embedding-3-small`（1536 维）或 `text-embedding-3-large`（3072 维）。同一把 key，走 `openai` 提供方：

```bash
EMBEDDING_PROVIDER=openai
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=1536
EMBEDDING_BASE_URL=https://hkust.azure-api.net/hkust-genai/v1
EMBEDDING_AUTH_HEADER=api-key
```

`EMBEDDING_AUTH_HEADER` 缺省是 `bearer`，指向 Azure API Management 网关时需要设成 `api-key`。

`bge-m3`、`multilingual-e5-large`、`e5-mistral` 出现在网关的模型列表里，但团队权限不足时会返回 403（`team_model_access_denied`）。用 `curl` 直接确认某个模型是否可用，再写进 `.env`。

## 换配置之后

改嵌入服务的提供方、模型或维度会使现有索引失效，健康检查返回不兼容，检索报错并提示执行重灌。运行 `pnpm --filter @research-lab/api rag:reindex` 重建；使用 PGlite 时先停掉 API，数据目录同一时间只能被一个进程打开。切换聊天模型不影响已有向量。

新索引键不与旧键比较，重灌前后配置不同属于正常情况。

## 密钥

密钥只放在 `apps/api/.env`，不进前端环境变量，也不进请求 URL。`EMBEDDING_API_KEY` 用于 Voyage 与 Jina，OpenAI 提供方复用 `OPENAI_API_KEY`。

密钥留空时启动不会失败，检索时才会报出原因，并降级为稀疏检索，报告末尾附检索说明。
