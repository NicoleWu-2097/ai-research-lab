# RAG 故障与替代方案

2026-11-15 排查：PostgreSQL 可连接，索引配置兼容；Ollama embedding 请求失败，错误为 ECONNREFUSED，本机 11434 无监听。已启动现有 Ollama 服务。现有上传统一错误掩盖了依赖故障，现已按连接失败、编码、超时和配置不兼容分类提示。

## 如何减少自研

| 方案 | 能替代的部分 | 接入成本及适用情况 |
| --- | --- | --- |
| LangChain JS + PGVectorStore | 文档加载、切分、embedding 集成及向量检索组件 | 最贴近现有 TypeScript/LangGraph/PostgreSQL；仍需维护上传任务、持久化与错误处理，并非完整知识库服务 |
| Dify Knowledge API | 文档上传、解析、分块、索引进度与检索 | 适合将知识库整个交给成熟服务；本项目保留研究图和审批，仅对接上传/查询接口。需独立部署或服务账号 |
| RAGFlow | 文档解析、数据集和检索服务 | 适合复杂文档需求；独立部署成本较高，官方起步建议 4 核、16 GB RAM、50 GB 磁盘，应先核对所选版本的平台支持 |
| AnythingLLM | 工作区知识库、模型配置与开发 API | 可作为独立本地知识库应用；应核对选用部署版本的 API 是否提供所需片段与来源信息 |

建议：如果目标是“避免维护知识库实现”，优先接入 Dify 的 Knowledge API，而不是仅把自写向量 SQL 换成一个库。若目标是保持当前轻量架构，则先逐步使用 LangChain 文档/向量组件；避免一次重写研究、审批和资料系统。这里是根据现有项目约束作出的工程判断，尚未部署或迁移这些方案。

## 迁移边界

1. 先定义知识库适配器，提供上传、查询索引状态及检索三个能力；上传返回“处理中”，不提前声称可检索。
2. 将外部片段映射为本项目的正文、来源 ID、文档名、时间与内容哈希；保持稳定的引用快照。
3. 前端沿用底部上传入口，状态轮询对接外部索引任务；服务端保存服务凭证。
4. 原研究图继续负责计划、预算、审批和报告质量标注。保留原索引以便回退，迁移不复用不兼容的 embedding 向量。

任何方案若继续使用本机 Ollama，都仍要求模型服务在线；更换框架本身不会解决 ECONNREFUSED。

## 官方资料

- [LangChain JS PGVectorStore](https://docs.langchain.com/oss/javascript/integrations/vectorstores/pgvector)
- [Dify Knowledge API：上传、索引状态和检索](https://docs.dify.ai/en/api-reference/guides/knowledge)
- [RAGFlow 快速开始及资源需求](https://github.com/infiniflow/ragflow/blob/main/docs/quickstart.mdx)
- [AnythingLLM API](https://docs.anythingllm.com/features/api)
