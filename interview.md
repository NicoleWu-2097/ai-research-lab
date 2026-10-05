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

## 2026-10-05：Milestone 4，真实 MCP 资料服务

### 本轮需求与结果

用户要求继续完成 M4。已接入官方 MCP TypeScript v2 SDK（client/server 均锁定 2.3.0），实现独立 stdio 子进程、工具发现、只读资料列表/读取、Agent 选择、来源上下文及页面工具活动。配置与手工验证见 [milestone4.md](docs/milestone4.md)，SDK 用法核对了[官方 v2 文档](https://ts.sdk.modelcontextprotocol.io/v2/)。

### 为什么第一个工具是本地文档？

研究项目架构时，已有 ADR 就是有用资料。本地资料能离线运行、固定输入并验证访问边界，也不需要搜索服务账户。默认目录为 `docs/decisions`，可通过 `MCP_DOCUMENT_ROOT` 改为准备好的 Markdown 资料目录。这里是按 ID 读取全文，尚未实施分块、向量索引、embedding 或 RAG。

### 这是真实 MCP 吗？为什么自己写 server？

宿主使用官方 Client，通过 SDK StdioClientTransport 启动独立 server；server 使用官方 McpServer 注册两个有 schema 的工具。初始化握手、工具发现和调用均由 SDK 执行，跨进程传输 JSON-RPC；自写部分只实现这个项目的资料访问规则。与直接函数调用相比，这使工具服务具有明确协议边界，也可以被其他兼容 MCP host 启动。

### MCP 与模型 tool calling 的区别

MCP 描述 host 如何发现和执行工具，并不负责让 LLM 决定调用什么。本阶段先列出资料，再使用 M2 的 structuredOutput 从已列出的 ID 中选择一份或 `none`；宿主再次校验选择后调用 `read_document`。这是有界的结构化选择流程，尚未接入 provider 原生 function calling 或 ReAct 循环。最多两次工具调用使成本、权限和测试范围明确；自主检索循环留给后续阶段。

### 权限由谁执行？

host 只允许 `list_documents` 和 `read_document`。server 限定根目录、文件名格式和 `.md` 扩展名，不递归；读取最多 24,000 字节，使用 O_NOFOLLOW 拒绝符号链接，并验证普通文件。工具的 readOnlyHint 等 annotation 只描述意图，实际安全边界由代码实施。模型不控制子进程命令、环境或目录，API 密钥不传递给子进程；尚未提供 OS 级沙箱，因此只运行受信任的本地 server 代码。

### 如何处理取消、错误和来源？

每个任务独立创建会话，协议请求上限 10 秒，总截止时间仍为 MODEL_TIMEOUT_MS，最终在 finally 关闭 client 与 transport。工具错误发 TOOL_FAILED 并终止任务，返回脱敏 MCP_TOOL_FAILED；模型选择阶段的已知模型错误保留原有类型。源文档包含 ID、SHA-256、读取时间，报告按 ID 引用，页面显示发现/调用/结果/来源事件。来源作为不可信数据进入提示词，提示词隔离不保证防住所有注入，文档存在也不等于结论正确。

### 验证与下一步

30 个测试及类型、lint、格式、构建、peer 检查和 frozen-lockfile 安装通过。新增测试使用真实 stdio 子进程，覆盖发现/读取、目录穿越、符号链接、大文件、Agent 选择与跳过、目录失败和取消，并验证前端显示工具活动。

编译后 API 在端口 3014 使用真实 Ollama `gpt-oss:20b`，成功选择并读取 `0003-storage-and-protocol-boundaries.md`，最终以该 ID 引用资料并发出 AGENT_COMPLETED（序号 116）。临时服务已关闭；本轮没有使用真实 OpenAI API，也没有浏览器视觉验证。停在 M4，待用户验证后再进入 M5。

## 2026-10-05：Milestone 5，基础 RAG 与引用追溯

### 本轮需求与结果

用户要求开始 M5，随后要求继续完成。已实现 Markdown 摄取、内容去重、重叠分块、PostgreSQL/pgvector 存储、独立 embedding 配置、检索与健康接口、研究工作流引用校验和页面原文展示。提供 Compose、重新摄取命令及简洁的 `docs/milestone5.md`；在 step.md 标记等待用户验证，未进入 M6。沿用每轮对话追加本文件的规则。

### 为什么 generation 与 embedding 分开配置？

生成模型不一定能输出适合检索的向量，两个阶段的模型、维度与服务地址需要独立选择。embedding 使用官方 Ollama/OpenAI SDK，显式配置 provider、model、dimensions，验证向量数量、维度、有限数值和非零向量；Ollama 禁止静默截断。维度设置是对原生输出的校验，不做自动降维。OpenAI 的返回按输入 index 排序。默认不启用 RAG，避免升级后强制依赖数据库；开启后固定走一次本地检索，MCP 全文选择仍可在 RAG 关闭时使用。

索引配置指纹包括 embedding provider、endpoint、model、dimensions、分块版本和资料目录。改变这些配置必须重新摄取，防止不同向量空间或资料集静默混用。同名模型 tag 更新权重不在指纹检测范围，操作者仍须重新摄取。

### 如何分块、去重和定位？

复用 M4 的受限文件读取器：单层可信目录、最多 30 个合法 ASCII 文件名的 Markdown、每份不超过 24 KB、不跟随符号链接。Markdown 原样解码为文本，保留格式，不引入 PDF/HTML 解析器。原始文件 SHA-256 去重，同内容选文件名排序首个来源，不维护别名列表。

分块最多 900 个 UTF-16 单位、相邻重叠 120，边界避开代理对。保存 `[start,end)` 字符范围、起止行、原文 SHA-256、摄取与检索时间；稳定片段 ID 由文件名、文档哈希、字符范围生成。优点是简单且能精确映射回快照；代价是可能切断标题或句子，也不等同 token 预算。中文、段落分块与 tokenizer 的收益后续靠评估决定。

### 为什么全量事务替换、精确检索？

当前语料很小，全量重建便于正确处理修改和删除，不需要增量任务状态机。先完成所有文件读取和 embedding，之后在一个数据库事务中替换索引；读写锁协调查询与替换，失败回滚保留旧索引。向量和元数据参数化写入，索引记录存配置指纹。单资料集设计，多个不同资料集并行摄取会竞争同一快照，因此不支持多租户或并行资料集管理。

检索使用 pgvector 的精确余弦距离，按距离和稳定 ID 排序，最多 4 段，默认相似度阈值 0.4。这只是教学起点，不是经过评测的最佳参数，也不是概率。小语料不引入 HNSW、全文混合检索或 reranker。更正 ADR 0003 中过宽的 M5 描述：M5 实际只持久化来源片段和向量，任务/事件持久化留给 M9，全文检索属于后续候选。

### 引用编号为什么与片段 ID 分离？

首次真实模型测试中，要求模型复写 64 位哈希的引用未通过校验。改用每次请求局部的 `[RAG:1]` 等编号，检索事件保留 `id → chunkId → documentId / sha256 / 位置 / 原文片段` 的映射。模型提示词只提供编号与片段内容，降低复制负担；完整元数据用于 UI 和审计。

另一次真实生成使用了中文括号 `【RAG:1】`，属于格式差异。现在最终报告先规范化这种括号，再检查引用集合，未知编号和没有引用仍报 MODEL_INVALID_OUTPUT；不会把失败草稿标记为完成。前端可展开原文并显示稳定片段 ID。短编号仅在单次任务内有意义，不能脱离映射跨报告复用。

### 证据不足、可信度与取消边界

零命中时直接返回本地证据不足，不调用生成模型。命中后提示模型仅依据片段、区分规划与已实施能力、不编造性能结论；引用校验只验证标识对应，不验证语义蕴含。真实试跑也曾出现资料外推断，因此没有宣称能保证每个结论正确；语义评估、Critic 和更强约束属于后续里程碑。片段作为不可信数据，提示词隔离不是完善的注入防护。

embedding 使用任务 AbortSignal 和 deadline；数据库查询有连接/语句超时。请求取消会停止等待，但不等于所有已发出的 SQL 都被即时撤销；摄取在提交前检查取消并回滚，提交后的取消不能撤回已完成事务。补修了 raceWithAbort 在传入已取消 signal 时对已有 Promise 的拒绝处理，避免未处理拒绝。

健康接口检查数据库和索引指纹，不通过远程 embedding 调用来证明模型在线。检索失败返回脱敏 RAG_FAILED，数据库空闲连接错误也有独立事件，避免泄漏连接凭据。

### 验证结果与环境限制

44 个测试通过（API 38、Web 6），类型、lint、格式和构建通过。新增真实 pgvector SQL 测试覆盖排序、阈值、原文位置、Unicode 分块、稳定 ID、重复摄取、内容更新、失败回滚、模型/资料目录配置不匹配、取消与超时、无命中、引用映射及伪造引用。SDK 适配测试覆盖 OpenAI 输入顺序恢复、Ollama 参数、坏向量和取消；UI 测试验证来源片段可见。

机器没有 Docker/PostgreSQL 命令，本轮用 PGlite 的 PostgreSQL WASM + pgvector 扩展执行同一 SQL；生产仍通过 pg 连接外部 PostgreSQL，不把 PGlite 当默认运行存储。已提供外部数据库 Compose，但未运行其镜像、TCP 连接或多连接并发锁测试。

获得下载授权后安装本地 `embeddinggemma`（约 621 MB），以 768 维 embedding 配合已有 `gpt-oss:20b` 完成真实冒烟验证：摄取 3 份 ADR、生成 4 个片段、检索命中包含存储决策原文的片段，最终 CITATIONS_VALIDATED 后 AGENT_COMPLETED（序号 590）。日志位于 `/tmp/ai-research-m5-smoke.log`。测试数据库为临时内存实例，已关闭；没有改写用户 .env。未调用真实 OpenAI，也未做浏览器视觉检查。后续按 milestone5.md 验证外部数据库与页面后再进入 M6。

### 核查来源

核对了 [pgvector 官方 README](https://github.com/pgvector/pgvector) 的余弦运算及镜像标签（Compose 使用 0.8.7-pg17）、[PGlite 官方扩展说明](https://pglite.dev/extensions/) 与 [API 文档](https://pglite.dev/docs/api)、[Ollama embedding 官方说明](https://ollama.com/blog/embedding-models)，并检查已安装 SDK 类型。PGlite 与 pgvector 扩展仅作为 devDependencies，依赖锁定至确切版本。

## 2026-10-05：补齐 Docker 验证与外部 PostgreSQL 接口

用户明确授权自行安装 Docker 并执行相关操作，同时要求预留外部 PostgreSQL 接口。本轮完成这两项，不进入 M6。

### 为什么使用 Colima？

在 macOS 安装 Docker CLI 29.8.2、Compose 5.6.0 与 Colima 0.10.3，由 Colima 在轻量 Linux VM 内运行真正的 Docker Engine，适合当前命令行开发流程。按 [Colima 官方说明](https://github.com/abiosoft/colima) 使用 Homebrew 安装与启动，VM 分配 2 CPU、2 GiB 内存、20 GiB 磁盘上限，使用 macOS Virtualization.Framework。合并 Docker CLI 插件目录配置，保留原有配置项；当前 Docker context 为 colima，没有安装登录自启动服务。

首次启动遇到 VM 的 `/etc/resolv.conf` 指向不存在的 systemd-resolved 文件，导致镜像拉取 DNS 失败。配置 DNS 为 1.1.1.1/8.8.8.8，并将 VM 的 resolv.conf 链接修复到持久文件 `/etc/resolv.conf.colima`，随后成功拉取官方镜像。此改动只在新建的 Colima VM 内，未修改宿主机 DNS。

### 外部数据库边界如何保留？

所有数据库访问仍由 pg 适配器实现，Compose 只负责本地服务，不进入业务逻辑。`DATABASE_URL` 可以替换为外部 PostgreSQL 连接串；新增独立配置解析器，限制 postgres/postgresql 协议，提供 `DATABASE_SSL_MODE=verify-full` 及可选 `DATABASE_SSL_CA_FILE`，启用证书和主机名验证，不提供关闭证书校验的 TLS 模式。`disable` 仅表示禁用 TLS，供本地数据库使用。

核对 [node-postgres SSL 文档](https://node-postgres.com/features/ssl) 后，显式禁止 DATABASE_SSL_MODE 与连接串 ssl/sslmode/sslcert/sslkey/sslrootcert 参数混用，避免 URL 配置覆盖手工提供的 CA。未设置显式模式时仍支持服务商提供的连接串参数。外部服务需要 pgvector，管理员可预先安装扩展；摄取账号需具备 schema/表创建、读写和表锁权限。运行说明已补入 docs/milestone5.md，连接账号与证书不写入仓库。

### 本轮验证与问题修复

Compose 启动成功，实际版本 PostgreSQL 17.11 / pgvector 0.8.7。通过真实 pg TCP 连接摄取 3 份 ADR、4 个片段；`/api/rag/health` 返回 ready，检索接口返回来源片段。重启容器后仍有同一索引及 4 个片段，验证了命名数据卷持久性。

新增可选真实数据库集成测试，使用 TEST_DATABASE_URL，在随机独立 schema 中创建并清理测试表，不替换业务 rag_* 数据。覆盖向量排序与阈值、事务失败回滚、并发读写时完整索引配置或明确不匹配错误，避免不同维度混用。普通测试未提供 TEST_DATABASE_URL 时跳过这两项。

HTTP 端到端首次发现模型输出 `[ RAG:1 ]` 被严格引用检查误拒绝。修复为规范化中英文括号及引用编号外围空白，随后仍对真实来源编号做严格匹配；补充了回归测试。第二次真实 HTTP 请求完成 CITATIONS_VALIDATED 与 AGENT_COMPLETED（事件序号 351），日志 `/tmp/ai-research-m5-postgres.sse`。生成与 embedding 均使用本地 Ollama，存储使用真实容器 PostgreSQL；不是嵌入式测试数据库。

API 42 个测试（含真实 PostgreSQL 2 个）和 Web 6 个测试通过；类型、lint、格式及构建通过。云端 PostgreSQL 的具体账号、网络和 TLS 握手尚未测试，因为尚未提供外部服务；当前已预留且验证配置边界。

### 留给用户的运行状态

保留 Colima 与数据库容器运行，保留命名数据卷；关闭本轮临时 3015 API。为已有 apps/api/.env 追加本地 RAG 配置，保留原生成模型配置；现在可直接 pnpm dev。停止数据库用 docker compose stop，恢复用 docker compose up -d --wait；停止 VM 用 colima stop，重启机器后 colima start。step.md 与 M5 文档同步更新，等待用户验证后进入下一里程碑。

## 2026-10-05：Milestone 5 最终收尾验收

用户要求继续完成 M5。本轮对照 step.md 检查后，核心功能和真实 PostgreSQL/HTTP 验证均已有，剩余收尾集中在真实浏览器验收，以及删除文档后重新摄取的明确回归覆盖。

通过 Edge 独立验收标签访问运行中的 localhost:5173，提交 PostgreSQL/pgvector 选型问题。实际看到 running → completed、命中 1 个片段、引用映射校验成功，并展开 `0003-storage-and-protocol-boundaries.md` 第 1–17 行，核对 `[RAG:1]`、稳定片段 ID、SHA-256、相似度及原文。检查了报告及展开来源的页面截图，当前纯文本报告与来源可读；报告仍显示 Markdown 原文，完整富文本展示留待后续 UI 阶段。任务 ID 为 `181b91c1-21f2-45dd-b84c-3573d9fc84dc`。本轮使用现有开发服务，没有重启用户运行中的进程。

新增回归测试在临时资料目录中删除文档并重新摄取，确认被删除来源不再检索到、剩余来源仍可检索；进一步删除全部文档后，索引片段数为零且检索返回空。空资料集视为有效快照，允许显式全量清空；其 health compatible=true 表示配置兼容，不表示一定存在可用证据，需同时检查 chunks。生产语料与数据库未被该测试改动。

API 43 个测试通过（含 2 个真实 PostgreSQL 集成测试）；Web 沿用此前通过的 6 个测试，本轮未改前端代码。类型、lint、格式检查通过。step.md 的 M5 实施清单全部勾选，运行说明补充验收结果。开发侧 M5 已完成，等待用户确认后再进入 M6；没有把语义正确性、云数据库实连或后续 Agentic RAG 算作本轮已完成内容。
