# HKUST 模型网关

实际配置文件为 `apps/api/.env`，已切换为 openai / gpt-4o-mini。填写其中留空的 OPENAI_API_KEY，然后重启 API。

请求使用 `https://hkust.azure-api.net/hkust-genai/v1/chat/completions`，Content-Type 为 application/json，认证头为 api-key，正文包含 model 和 system/user messages。使用现有 OpenAI 官方 SDK，不额外安装客户端。OPENAI_BASE_URL 填到 `/v1`，SDK 自动补 `/chat/completions`。

新增 OPENAI_API_STYLE=chat-completions 和 OPENAI_AUTH_HEADER=api-key。普通官方 OpenAI 仍可使用 responses / bearer。网关按截图使用非流式请求，应用收到完整文本后作为一个输出片段展示；不要求学校网关支持 SSE。结构化步骤使用 JSON Schema 提示及本地 Zod 校验，不假定该网关支持 response_format。

截图只证明聊天接口，没有证明 embedding 接口。嵌入默认接外部嵌入服务（Voyage），填写 `EMBEDDING_API_KEY` 即可使用；Ollama 是可选路径。更换嵌入配置后需要重灌全部语料，命令为 `rag:reindex`；聊天模型切换不要求重新生成现有向量。

密钥留空时启动会提示配置错误，这是等待用户填写的预期状态。配置变化后旧任务不能直接恢复，请创建新任务。密钥仅放在 API 的 .env，不放前端环境变量或请求 URL。本轮没有密钥，因此仅完成模拟 HTTP 协议测试，未向学校网关发真实请求。
