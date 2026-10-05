# AI Research Lab：架构决策面试记录

本文件按对话顺序追加。回答中的“当前”指记录日期；未来改动以新记录说明，不覆盖旧决策。架构细节见 [architecture.md](docs/architecture.md) 与 [ADRs](docs/decisions/)。

## 2026-10-05：项目目标与 Milestone 0 决策

### 一句话介绍项目

AI Research Lab 是一个本地可运行的研究型 Agent 系统：接收问题、收集和评估证据、补充薄弱证据，最终生成可追溯引用的报告。它按里程碑构建，以便验证每一层的架构价值，而不是一次性拼装框架演示。

### 面试可能问：为什么选择 LangGraph.js？

研究流程需要显式状态、条件分支、有上限的研究循环，以及后期的检查点和人工暂停。LangGraph.js 的图节点适合把“计划 → 研究 → 批评 → 继续或停止”表示成可检查、可测试的状态转换。它在 2026-10-05 仍由官方维护。[官方文档](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)说明了持久执行、流式进度与中断；[仓库](https://github.com/langchain-ai/langgraphjs)可查发布活动。

取舍：图和状态设计有学习与维护成本，所以 M3 先用一条小图；HTTP、模型、RAG 和协议层保留普通 TypeScript 接口，不让 LangGraph 类型渗透到所有模块。LangGraph 只负责工作流，不自动意味着全项目都使用 LangChain 抽象。

### 为什么不选 OpenAI Agents SDK 或 Mastra 作为主编排框架？

[OpenAI Agents SDK](https://openai.github.io/openai-agents-js/guides/agents/) 的 agent、handoff、session 和 tracing 适合快速构建以 agent 为中心的流程；但本项目更重视显式状态图及 Ollama/OpenAI 双 provider。若用它作为主框架，仍须仔细处理模型适配和工作流状态。[Mastra](https://mastra.ai/en/reference/workflows/snapshots) 的工作流、存储和观察能力更一体化，开发效率可能更高；本项目希望分别展示模型、检索与协议边界，故选择粒度更低的 LangGraph。两者都是有效候选，并非“不成熟”。

### 为什么单独设计模型接口，而不让 Agent 直接调用某个 SDK？

要在本地 Ollama 与 OpenAI 之间通过配置切换，且可以注入 fake model 做确定性测试。应用接口只表达真正需要的生成、流式输出、结构化输出和能力错误；具体调用分别由官方 [`openai`](https://github.com/openai/openai-node) 与 [`ollama`](https://github.com/ollama/ollama-js) 客户端处理。

难点是模型能力并不一致：Ollama 的工具调用与结构化输出是否可靠取决于选定模型。接口不能假装所有 provider 完全等价。M2 要实测能力；不支持时返回明确错误或经验证的降级结果，绝不静默改变研究语义。模型名、地址和密钥均来自配置。

### 为什么初期只有一个 Research Agent？

多个角色只有在职责、权限、输入输出和独立评估标准确实不同的情况下才有价值。初期先验证完整纵向路径，避免把普通函数拆成一堆伪 Agent。M7 根据真实瓶颈考虑 Coordinator、Critic 或来源专员；M8 再把有独立服务意义的角色移到 A2A 边界。

### LangGraph、MCP、A2A 各解决什么问题？

LangGraph 管一个工作流中的状态与控制流；[MCP](https://github.com/modelcontextprotocol/typescript-sdk) 标准化 Agent 到工具/数据的发现和调用；[A2A](https://github.com/a2aproject/a2a-js) 标准化独立 Agent 服务之间的发现、任务、消息、进度与产物。M4 用官方 MCP SDK 接真实工具；M8 运行至少两个独立进程并做真实 A2A 集成。进程内函数调用不需要包装成 A2A。MCP v2 与 A2A v1 SDK 的实际兼容版本在对应里程碑锁定并测试。

### 为什么用 PostgreSQL + pgvector，而不是 Qdrant？

[pgvector](https://github.com/pgvector/pgvector) 支持向量检索，可配合 PostgreSQL 全文检索；任务、事件、来源、报告和向量可先放在一套本地服务中，减少部署与数据同步。[Qdrant](https://qdrant.tech/documentation/search/hybrid-queries/) 的密集/稀疏向量混合查询更直接，但任务和报告仍需另一套存储。我们选择先用 PostgreSQL + pgvector，在 M5/M12 用实际语料测试召回、排序、中文分词和资源消耗；若不够用再调整。这个决定不是声称 pgvector 检索质量天然更好。

### Hono、React、持久化分别处在哪个边界？

[Hono](https://hono.dev/docs/getting-started/nodejs) 处理外部 HTTP：验证、任务接口、健康端点、SSE 与后期审批。React/Vite 展示任务、事件、证据和报告，不作为真实任务状态的来源。PostgreSQL 从 M5 开始保存任务、事件和来源；后期保存 LangGraph 检查点。短期工作流状态、长期知识库和审计事件分开建模，不统称“记忆”。

### 如何保证报告中的引用可追溯？

摄取时保存来源 URL 或文件定位、获取时间、内容哈希和片段位置，给每条证据稳定 ID。报告中的结论指向证据 ID，应用再把 ID 映射回来源；不能信任模型随手生成的 URL。对于缺少足够证据的结论，应明确写明不确定性并允许研究循环补证。M5 先用固定本地文档做确定性验证。

### 最重要的工程风险是什么？

本地模型能力差异；节点恢复时副作用重放；pgvector 混合检索效果与中文分词；MCP/A2A 版本演进；外部内容的提示注入和来源质量。对应措施是能力测试、幂等/审批、检索评估、协议集成测试，以及默认最小工具权限。外部内容是数据，不能直接成为 Agent 指令。

### 为什么分阶段引入基础设施？

M1 只验证仓库、API、UI 和质量工具；M2 才加模型；M3 才加一个 Agent；M4/M5 才加 MCP/RAG；M8 才加独立 A2A 服务。每阶段有可运行结果和停止点，便于定位问题，也能说明新增依赖具体解决了什么。M1 的验收目标是 React 显示 Hono 健康状态，且安装、启动、类型、格式、lint 与测试都可重复完成。

### 本轮对话摘要

- 用户要求先阅读 `initial.md`、规划步骤且不写实现代码；已创建 [step.md](step.md)。
- 用户随后要求实施 Milestone 0，并让面向开发者的文档尽量简洁；已创建 [架构文档](docs/architecture.md) 和三份 ADR，未搭建应用。
- 用户本轮要求将决策整理为面试材料，并从此把后续对话摘要追加到本文件；相应规则已写入 `step.md`。

### 尚未决定

首个外部搜索来源及配额、论文/GitHub 内容范围、多用户鉴权需求、优先支持的本地硬件和 Ollama 模型。这些不阻塞 M1。

## 2026-10-05：Milestone 1 实施与验证

### 本轮对话摘要

用户要求实现 Milestone 1。已创建 pnpm/Turborepo TypeScript monorepo、Hono API、React/Vite 状态页、ESLint/Prettier/Vitest 配置、README 和 lockfile；尚未接入模型、数据库、MCP 或 A2A。M0 架构与 ADR 随用户要求进入 M1，状态更新为“已接受”。

### 面试可能问：为什么只建 `apps/api` 和 `apps/web`，没有 `packages/contracts`？

当前唯一跨应用数据是极小的健康响应。为了这一个对象创建共享包会增加构建与依赖成本，收益有限。API 通过 HTTP 返回响应，前端把 JSON 当作 `unknown` 检查 `status` 后再显示结果。未来出现研究任务/事件等真实共享契约时再提取 `packages/contracts`，届时用 Zod schema 同时驱动运行时验证与 TypeScript 类型。

### 为什么前端使用 Vite 代理？

开发环境中浏览器只请求同源 `/api/health`，Vite 将 `/api` 转发到 Hono。这样前端不需要写死 API URL，也不需要为本地开发放宽 CORS；后端目标可通过 `API_DEV_PROXY_TARGET` 配置。生产部署的反向代理/同源策略留到需要部署时确定。

### 为什么 TypeScript 固定为 6.0.3？

安装时最新 TypeScript 7.0.2 超出当时 `typescript-eslint@8.71.0` 的 peer 范围（要求 `<6.1.0`）。因此选用仍满足该范围的 TypeScript 6.0.3，执行 `pnpm peers check` 无冲突，并提交精确依赖版本和锁文件。这是兼容性决定，不是长期禁止升级。

### 为什么允许 esbuild 的安装脚本？

pnpm 11 默认阻止未批准的依赖构建脚本。Vite/Vitest 使用 esbuild，安装时明确批准了 `esbuild`，并在 `pnpm-workspace.yaml` 中留下 `allowBuilds` 记录，避免开发者本机重复遇到安装失败。没有开放所有依赖脚本。

### 如何验证 Milestone 1？

`pnpm install --frozen-lockfile`、`pnpm peers check`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm build` 均通过。测试包括一个 Hono 健康端点测试和两个 React 页面状态测试。启动 `pnpm dev` 后，直接请求 `http://localhost:3001/api/health`、经 Vite 代理请求 `http://localhost:5173/api/health`，以及请求页面入口，三者均返回 HTTP 200。浏览器中最终显示效果留给用户按 README 手工确认。

### 后续停止点

停在 M1，等待用户本地验证反馈；不自动实施 M2。M2 才设计模型接口并接入 OpenAI/Ollama。

## 2026-10-05：Milestone 2 模型层

### 本轮对话摘要

用户确认 M1 已通过并要求实施 M2。新增 `ModelProvider` 接口、OpenAI/Ollama 官方 SDK 适配器、环境配置校验、普通生成与 SSE 流式 HTTP 接口、请求截止时间及取消处理。README 增加本地运行步骤；没有加入 Agent 工作流或数据库。

### 面试可能问：模型抽象的边界在哪里？

调用方只依赖 `generate(prompt, signal)`、`stream(prompt, signal)` 和 `structuredOutput(prompt, zodSchema, signal)`；`provider` 与 `model` 是可观察元数据。适配器处理 SDK 请求与响应格式，HTTP 边界负责 Zod 输入验证、超时、取消和错误状态。这个接口覆盖当前需求，后续多轮消息或工具调用须在真实使用时扩展，不预设计庞大的跨厂商 API。

### 为什么使用官方 SDK，而不是统一模型网关？

官方 [`openai`](https://github.com/openai/openai-node) 与 [`ollama`](https://github.com/ollama/ollama-js) 客户端直接对应各自协议，减少对第三方抽象更新节奏的依赖。OpenAI 走 [Responses API](https://github.com/openai/openai-node/blob/main/docs/responses.md)，流式只提取文本增量；结构化输出使用官方 [Zod helper](https://github.com/openai/openai-node/blob/main/docs/structured-outputs.md)。Ollama 使用 `chat`、流式迭代器及 JSON Schema `format`，结果再次由 Zod 验证。统一接口隔离调用方，但不声称各模型能力等价。

### 如何处理模型能力缺失？

配置中不硬编码模型，也不在启动时推断 Ollama 某个模型一定支持结构化输出。请求时由上游验证能力；明确的“不支持”响应映射为 `MODEL_UNSUPPORTED_CAPABILITY`，无效/缺失输出映射为 `MODEL_INVALID_OUTPUT`，其他上游失败为 `MODEL_PROVIDER_ERROR`。错误分类是保守映射，未知错误不会被伪装为“支持”。M3 引入工具调用前还需对选定模型做专项能力实测。

### 为什么未设置 provider 时 API 仍启动？

本地健康检查和 M1 前端不应依赖云密钥或下载模型。未设置 `LLM_PROVIDER` 时健康端点仍为 200，模型端点返回 `MODEL_NOT_CONFIGURED`/503；一旦选择 provider，则必须提供对应模型名及密钥/地址，错误配置在启动时失败。`.env` 只由 API 本地进程读取，日志不打印密钥或 prompt。

### 流式和超时如何工作？

Hono 将 provider 的文本片段转换为 SSE `delta`，成功后发 `done`，流启动后失败发 `error`。每次请求有 `AbortSignal` 和可配置 `MODEL_TIMEOUT_MS`。OpenAI SDK 接收请求级 signal；当前 Ollama JS 未提供 `chat` 的外部 signal 参数，因此适配器为每次调用建立客户端，并在注入的 fetch 中合并 SDK 与应用的 signal。HTTP 边界另以 `raceWithAbort` 限制等待时间，即使 fake provider 忽略 signal，也能结束请求。底层是否立即停止计算仍取决于 provider。

### 为什么没有在 React 上增加 prompt 输入？

M2 的目标是验证模型抽象与流式协议，最小入口是两个 Hono 端点。研究任务 UI 属于后续里程碑；此时增加聊天界面会混淆“模型调用”和“Research Agent”。

### 验证和限制

fake provider 测试覆盖 HTTP 响应、SSE、输入校验、未配置、超时和错误；模拟 HTTP 测试覆盖两个官方 SDK 适配器的文本、流式与结构化输出。真实 Ollama `gpt-oss:20b` 经 `/api/model/generate` 返回 `ready`，经 `/api/model/stream` 返回 `delta` 和 `done`。OpenAI 未使用真实密钥调用；其端到端网络行为留给配置该 provider 的用户手工验证。M2 完成后停下等待用户验证，不自动进入 M3。

## 2026-10-05：Milestone 3 单个 Research Agent

用户确认 M2 验证成功，要求实施 M3，并在中途要求继续。已加入真实 LangGraph 单节点工作流、研究 SSE 路由、前端问题表单/增量报告/取消按钮，以及状态和协议测试。开发者说明见 [milestone3.md](docs/milestone3.md)。

面试解释：本阶段把研究职责、question/report 状态、任务 ID 和执行生命周期放在普通模型接口之上。图为 `START → research → END`；节点使用已有 ModelProvider，通过异步回调把文本增量交给 HTTP 层，SDK 细节不会进入前端。LangGraph 的显式节点和状态为以后工具路由、条件分支和检查点提供扩展位置；当前只有一次模型生成，尚无自主工具选择或研究循环。相关机制参考 [LangGraph 官方说明](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph)。

为什么不直接暴露模型事件：前端只消费 `TASK_CREATED`、`AGENT_STARTED`、`REPORT_DELTA`、`AGENT_COMPLETED`、`AGENT_FAILED` 和 `TASK_CANCELLED`。每条事件有任务 ID、序号和时间戳，模型切换不会改变页面协议。解析器处理跨网络分块的 UTF-8 文本，缺少终态的断流会报告失败。

取消与存储的取舍：当前任务只在请求生命周期内存在，点击取消或页面断连会触发 AbortSignal，取消图执行和模型等待。没有数据库、任务历史或恢复回放；这是持久任务实现前的临时边界，不能把 M0 的最终后台执行目标当成已经完成。请求截止时间沿用 MODEL_TIMEOUT_MS；日志只记录任务元数据，不记录正文。

可信度边界：提示词要求产出初步结论、理由、不确定性和下一步待查证据，并明确没有外部检索工具。页面同步说明这一限制。当前不能宣称报告引用已核验；真实来源追踪在 MCP/RAG 阶段实现。

验证：25 个测试通过，覆盖后端图执行/状态顺序/失败/超时/取消，以及前端表单提交/取消、SSE 分块和不完整流；类型、lint、格式、构建、依赖 peer 检查及 frozen-lockfile 安装通过。真实 Ollama `gpt-oss:20b` 在测试端口 3013 经新研究接口返回 124 条任务事件，以 `AGENT_COMPLETED` 和完整初步报告结束，测试服务已关闭。尚未进行真实浏览器视觉检查，等待用户按文档验证页面后再开始 M4。
