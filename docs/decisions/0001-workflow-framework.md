# ADR 0001：LangGraph.js 负责编排

状态：已接受。日期：2026-10-05。

## 决定

从 M3 使用 `@langchain/langgraph` 表达研究状态、分支、循环、检查点和人工暂停。节点优先写普通 TypeScript；不因选用 LangGraph 而让整个应用依赖 LangChain 的模型和检索抽象。

## 理由与取舍

研究流程后期需要可检查的状态和“证据不足 → 补充研究”的有界循环。[LangGraph.js 文档](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)明确支持状态图、流式进度、持久执行和中断；[官方仓库](https://github.com/langchain-ai/langgraphjs)在 2026-09 仍有提交与发布。它是更贴合这个教学目标的低层编排工具，但图状态和检查点会增加设计负担。

[OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/agents/) 的 agent、handoff、session 和 tracing 完整，适合快速搭建以 agent 为中心的流程；本项目的显式状态机及双 provider 目标会需要额外适配。其 [tracing 默认行为](https://openai.github.io/openai-agents-js/guides/tracing/)也需要在本地优先方案中专门配置。[Mastra](https://mastra.ai/en/reference/workflows/snapshots) 提供一体化 workflow、存储和观察能力且持续发布，开发体验好；在这里我们希望把模型、检索和协议边界分别展示，避免过早采用一体化平台。两者均非“不成熟”，只是本项目目标下的次选。

## 后果

M3 先建一条小图。M9 再加入多步循环与持久检查点；节点副作用必须可重试或幂等。框架只出现在 API 工作流模块，HTTP、模型、RAG 与协议层不依赖其类型。
