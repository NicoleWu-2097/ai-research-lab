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

## 2026-10-05–06：Milestone 6，Agentic RAG 与收尾

### 本轮需求与结果

用户要求继续完成 M6，随后在 10 月 6 日要求 continue；按已有规划完成实现、真实链路验证和文档收尾。请求进入 M6 视为允许从 M5 推进。新增 LangGraph 路由、取证、评估、回答节点，支持直接回答、本地检索、MCP 文档调用、补充取证和明确停止。页面展示路径、简短决策依据、证据评估与停止原因。step.md 标记 M6 已实现、等待用户验证，未进入 M7；本轮继续遵守每轮对话追加 interview.md 的规则。

### 为什么让模型选择路径，却由宿主限制执行？

模型适合判断问题是否需要来源、现有证据是否足够和下一次查询如何改写，但不应自行决定无限循环或调用未开放能力。模型只输出 action/reason/query 三个 schema 约束字段；宿主再次校验动作、阶段、可用能力、查询与预算，再决定图的下一条边。reason 是面向用户的简短解释，不要求输出私有推理过程。

首次允许 direct/local/mcp/stop；取证后允许 sufficient/local/mcp/stop，不允许退回无证据直接回答。sufficient 必须有来源。本地最多 2 轮，MCP 最多 1 轮，合计最多 3 轮取证、4 次路由或评估调用，另外最多 1 次 MCP 文档选择和 1 次报告生成。LangGraph recursionLimit=12 提供额外边界，所有阶段共用任务截止时间与取消信号。这是有界单 Agent 工作流，多智能体仍属于 M7。

### 为什么首次保留原问题，何时停止检索？

真实 gpt-oss 测试把原问题提前压缩成“项目 PostgreSQL pgvector 选择原因”，导致零命中；随后又提出相同查询，被宿主判定重复并停止。由此将首次查询固定为原问题，只在证据评估不足后允许改写，避免未经检索就丢失语义。调整后实际存储选型问题首轮命中并完成引用报告。

查询经 NFKC、大小写和空白规范化后按能力分别去重；同一问题可以先查向量索引，再调用 MCP。首次零命中允许补充取证；补充取证没有新增片段则停止，不继续消耗模型调用。重复查询、空查询、非法转移、能力不可用或预算耗尽也由宿主终止。即使已有部分证据，只要未达到充分性条件，仍返回明确的证据不足说明，不拼接缺少支持的完整结论。检索或工具实际异常终止为失败，与正常零命中分开处理。

### 多轮来源如何保持可追溯？

本地命中和 MCP 文档统一进入累计证据集。MCP 全文使用相同分块函数转换为片段，score=null，页面显示“MCP 文档片段”，不伪造向量相似度。稳定片段 ID 用于跨轮去重，请求内的 RAG:1 等短编号只追加、不重排，因此早期引用不会指向另一片段。

累计最多 8 段，每段最多 900 个 UTF-16 单位。MCP 按原文顺序保留能装入预算的片段，长文后部可能被截断；当前没有重排器。最终回答复用 M5 的来源提示和引用校验，不另建一套引用规则。引用标识有效只证明能定位到原文，不能证明每个断言被原文支持；模型的证据充分性判断仍可能出错，未来需靠评测和 Critic 改善。

### MCP 与模型原生工具调用有什么区别？

MCP 路径确实启动独立 stdio 服务，发现并调用 list_documents/read_document，但当前工具只读取可信目录中的本地 Markdown，不访问互联网。路由模型返回的 mcp/local 是动作标签，由宿主执行，不是让模型在该次推理中直接发起函数调用。一般问候等 direct 路径明确标记“未检索外部资料”；需要互联网独有事实时没有对应能力，应停止。

### 真实 Ollama 的结构化输出问题如何解决？

初次测试 gpt-oss:20b 将 mcp/local 或 repo_browser.search 当成原生函数调用，出现 Ollama 500 或空 content；应用按 MODEL_PROVIDER_ERROR/MODEL_INVALID_OUTPUT 拒绝，没有执行这些臆造函数。仅设置 format schema 并不足以消除模型对任务的误解。

Ollama structuredOutput 适配器增加系统提示：本次没有可调用工具，只返回符合 schema 的最终 JSON；同时把同一 JSON Schema 放进用户提示，并设置 temperature=0。路由提示进一步明确“这是分类任务”，给出 action 字段 JSON 示例，强调动作由宿主稍后执行。最终仍执行 JSON.parse 和 Zod 校验，不从异常函数调用中猜测或恢复动作。普通生成与流式输出未改动。降低温度不能保证完全确定性；提示中附 schema 的做法参考 [Ollama 官方结构化输出说明](https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx)。

### 配置、验证与交付边界

运行入口默认 AGENTIC_RAG_ENABLED=true，RAG_ENABLED/MCP_ENABLED 分别控制能力，false 可回退 M5 固定流程；工厂默认参数保留旧测试和调用方行为。未修改用户 .env。开发文档集中在简洁的 docs/milestone6.md；本地模型需要多次调用时可配置 MODEL_TIMEOUT_MS=180000，仍是整项任务共用的截止时间。

新增 12 个 Agentic 测试，覆盖路由、首次原查询、补充改写、稳定编号、预算、重复查询、无新增证据、空证据、非法动作、不可用能力、工具异常、取消与超时、真实 MCP 子进程及混合路径；SDK 和前端测试补充结构化提示、决策事件及 MCP 来源显示。普通测试 API 53 项、Web 6 项通过，另以真实 PostgreSQL 执行 2 项集成测试，共 61 项通过。pnpm typecheck、lint、format:check、build 及 git diff --check 通过。

临时 3016 API 使用真实 Ollama gpt-oss:20b、embeddinggemma、容器 PostgreSQL/pgvector 与 MCP stdio，HTTP SSE 四条路径完成：直接回答（AGENT_COMPLETED 序号 38）；本地检索后引用回答（363）；基准数据缺失，两轮取证无新增证据后停止（11）；MCP 列出并读取 ADR 后引用回答（431）。记录分别为 /tmp/ai-research-m6-direct.sse、local.sse、insufficient.sse、mcp.sse（后三项使用同一 ai-research-m6- 前缀）。调试时 Python 对 localhost 请求意外使用代理产生 502，测试客户端改为禁用代理后恢复，没有据此修改应用。

收尾确认 3016 已无监听，未关闭用户原有开发服务或数据库。M6 前端通过组件测试，未声称本轮做了真实浏览器视觉验收；未调用真实 OpenAI API，也未验证云 PostgreSQL 账号。停在 M6，等待用户按运行文档验收后继续。

## 2026-10-06：Milestone 7，Coordinator、研究执行者与 Critic

### 为什么现在拆分角色？

用户要求继续实现 M7。M6 已记录真实模型会对资料进行外推：引用编号校验只能证明段落存在，无法验证结论受到该段落支持。因此本轮针对明确的质量瓶颈引入研究执行和 Critic 两个模型职责，由程序 Coordinator 管理交接、预算和最终发布。没有依据角色清单一次性增加检索、论文、写作等专员；当前本地资料规模也不需要这些角色。

这次实现的是产品中的进程内多角色编排，没有启动开发任务的子代理。Coordinator 以 LangGraph 状态图实现 supervisor 策略，无需再增加一次模型调用来判断确定的轮次和分支。研究者和 Critic 使用同一个已配置的 ModelProvider，但独立提示词和输入上下文；这是职责专门化，不是模型异构或独立进程。A2A 属于 M8。

### 角色的输入、输出与权限是什么？

M6 取证并判断证据充分后，把原问题与累计片段快照交给 Coordinator。Handoff 定义 question/sources；研究执行者额外接收可空的 revision（上一稿和具体问题列表），产出草稿；Critic 接收原问题、同一组原文片段及当前草稿，输出 schema 约束的 verdict/issues/summary。

研究和审查都不能在该阶段自行检索或修改证据集合，Critic 不持有任何工具。Coordinator 持有证据快照，每次交接深拷贝，隔离进程内意外修改。结构化反馈限制最多 6 项、每项 700 字符；approve 必须没有 issues，revise 必须至少有一项，矛盾或未知 verdict 作为 MODEL_INVALID_OUTPUT 处理。公开 summary/issues 是短评，不请求或显示私有推理。

Critic 检查事实是否被所引用的原文支持、是否回答问题、是否混淆规划与已实现、是否编造测量、是否说明不确定性。明确要求允许有依据的保守回答和证据不足声明，不要求作者补写资料中不存在的事实。原文、草稿和反馈均在提示中声明为不可信数据；这不是完备的提示注入防护。

### 委派、反馈、冲突和失败如何处理？

状态图为 research → critic；通过后结束，否则允许返回 research 一次并再次审查。Coordinator 将原问题、同一证据集合、上一稿和具体 issues 交回执行者。修订复用 M5 生成和引用规范化/校验，Critic 不能覆盖引用编号检查。每次审查都会收到最新稿件，不把第一次通过条件复用于第二稿。

最多生成两稿、审查两次。第二次仍要求修改时返回“审查未通过”的明确说明，不靠投票或忽略 Critic 发布草稿。它是正常完成的有界停止，事件 outcome=review_unresolved；模型、协议、空稿、非法引用等实际异常则使任务失败。没有隐藏无限重试或绕过审查的降级，失败后用户可重新提交整个任务；本阶段没有 checkpoint 或中途恢复。

所有角色共用任务 AbortSignal 和总截止时间；raceWithAbort 能停止等待忽略 signal 的 fake agent，但不能保证取消后远端计算立即终止。问候的直接回答和已有证据不足路径不进入 Critic，避免没有明确价值的额外调用。

### 为什么先缓冲草稿再发布？

M6 原有报告流会边生成边显示草稿。M7 中首稿可能被 Critic 推翻，因此研究角色先在服务端缓冲，期间只发送委派、草稿就绪、审查和最终决策事件；通过后发布最终稿。这样不需要把不同版本的增量文本拼接，也不会短暂展示被否决的初稿。代价是报告正文的首字等待变长，进度由角色事件提供。审查中的引用校验事件只表示编号有效，不表示整稿已经通过。

前端“研究过程”显示 ROLE_DELEGATED、DRAFT_READY、CRITIC_REVIEWED、COORDINATOR_COMPLETED。AGENT_COMPLETED 表示整个流程结束，可能携带明确停止说明；角色事件与报告要结合阅读，不能把 completed 等同于结论已被证明。

### 收益、成本和配置取舍

有明确标准的第二次审查有机会发现起草时遗漏的限定条件；反馈修订构成一次有界反思。当前没有独立评测证明它一定提高准确率，同模型两种角色可能共享偏差，Critic 也可能误判，因此不称其为事实认证。继续保留原文追溯及“结论仍需核验”的提示。

相对 M6，正常通过增加一次 Critic 调用；发生修订时最多增加三次模型调用（两次 Critic、一次额外生成）。加上 M6 上限，最多 9 次模型调用：4 次路由/评估、1 次 MCP 选择、2 次生成、2 次审查。M7 内层图 recursionLimit=6，M6 外层边界继续生效。全部调用共用 MODEL_TIMEOUT_MS，本地慢模型可设 300000。

运行入口默认 MULTI_AGENT_ENABLED=true，且只在 AGENTIC_RAG_ENABLED=true 时生效；关闭前者回退 M6，关闭后者回退固定流程。工厂默认参数继续兼容旧调用。没有改写用户 .env、增装依赖或改动数据库结构，开发说明集中在简短的 docs/milestone7.md。

### 验证结果与本轮限制

新增 13 个测试，使用 fake agents 驱动真实 LangGraph，验证委派顺序、交接数据、一次修订、反复否决后停止、证据副本隔离、非法审查契约、空稿与角色失败、取消、M6→M7 集成、修订的引用重验、直接/不足路径跳过审查、Critic 超时的 HTTP SSE 失败。前端测试补充角色和审查反馈展示。首轮测试暴露 mock 的 once 队列覆盖了故障注入，改成按 revision 分支生成默认稿件后，故障和修改注入才实际执行；这属于测试夹具修正。类型检查也纠正了固定流程误传布尔参数和测试数据过窄的字面量类型。

最终普通测试 API 66 项、Web 6 项，共 72 项通过；2 项需 TEST_DATABASE_URL 的可选 PostgreSQL 测试本轮未运行（数据库代码未改，M6 已通过），没有算入 72 项。pnpm typecheck、lint、format:check、build 及 git diff --check 通过。

使用临时 3017 API、真实 Ollama gpt-oss:20b/embeddinggemma 和既有 PostgreSQL，提交存储选型及规划边界问题。任务 fabe121e-5316-440a-85be-820fdca3b45f 首轮本地检索命中 2 段，证据评估充分；事件 8 委派研究者，10 引用校验，11 草稿交接，12 委派 Critic，13 审查通过，14 Coordinator 发布，15 才出现 REPORT_DELTA，16 AGENT_COMPLETED。完整记录 /tmp/ai-research-m7-live.sse。手工阅读了事件、来源与报告；真实请求走首次通过分支，修订和再次否决由 fake agents 覆盖，没有声称真实模型必定选择某个分支。

真实报告仍有把 ADR 的里程碑描述解释为已实现状态的倾向，Critic 此次没有提出异议。这说明独立提示词和第二次审查不能代替实施状态来源或语义评测；不把本次成功执行等同于准确率已提升。此轮未做真实浏览器视觉检查，前端通过组件测试；未调用 OpenAI 或云 PostgreSQL。M7 完成后等待用户验证，未开始 M8。

### 手工核查后的补正

针对首次真实报告混淆 ADR 与实施证明的问题，在起草和 Critic 提示中都补充具体标准：已接受的 ADR、里程碑分配和未来规划本身不是代码已实现或测试已通过的证明；缺少实施/测试记录时必须将实际实现状态标记为未验证。保留上述首次观察记录，不将其改写成没有发生过。

补正后的第一次真实重试由模型选择 MCP，成功读取 ADR，但生成稿未通过引用编号校验，在事件 15 以 MODEL_INVALID_OUTPUT 失败，未进入 Critic、未发出 REPORT_DELTA，也未发布完成报告。日志 /tmp/ai-research-m7-final.sse。这体现模型输出仍可能不合约，不能为完成演示而绕过既有引用约束。随后重新提交一个要求本地检索、简洁回答并逐项引用的问题，用来继续检查补正后的实施状态措辞。代码门禁重新运行，仍为 72 项测试及类型、lint、格式、构建通过。

最终代码的真实任务 a689ed5d-884e-4e99-bcf5-10fd5144daa7 完成同样的 16 个事件，Critic 首轮通过后才发布，记录 /tmp/ai-research-m7-verified.sse。报告明确提到没有完成测试或部署的记录、无法确认完整实现，但仍含有“正在实现”“已在实施阶段”等超出 ADR 确认范围的措辞，Critic 仍未拦截。提示补正没有彻底消除这一模型局限；本轮交付的是可观察、有预算、有交接契约和失败边界的审查机制，未证明语义准确率改善。后续应以包含此类失败的评测集衡量角色价值，再决定更换审查模型、结构化逐项支持判断或补充实施状态来源，而不是继续增加无评测的重试。

已关闭本轮临时 3017 API，保留既有数据库和用户开发服务；README、step.md、运行文档与本文件同步收尾。等待用户验证 M7。

## 2026-10-07：Milestone 8，真实 A2A 边界

### 本轮需求与角色选择

用户要求继续完成 M8，允许从 M7 推进。本轮将研究执行者和 Critic 分别运行成独立本地进程，Coordinator 通过真实 A2A SDK 客户端调用。独立服务的意义在于分别部署、配置模型和执行时限、隔离进程生命周期；研究产物和只读审查具有不同输入输出及质量标准。没有把进程内函数改名为 A2A，也没有为开发任务启动子代理。

M7 的 ResearchAgents 接口保留：进程内实现和远程适配器都提供 research/critique，LangGraph Coordinator 不依赖传输类型。M6 仍在 API 内取证，证据充分后才委派；M7 仍控制最多一次修订及报告发布。每次起草、审查或修订都有独立远程任务 ID，总研究任务 ID 仍由主 API 管理，二者通过 SSE 事件关联。

### 为什么选这个 SDK 和传输？

核对 [官方 A2A JS SDK](https://github.com/a2aproject/a2a-js)、[A2A 1.0 规范](https://a2a-protocol.org/v1.0.0/specification/) 以及 npm 元数据后，固定安装 @a2a-js/sdk 1.3.0，使用其 A2A 1.0 JSON-RPC 和流式接口，不使用旧版 0.3 兼容层。SDK 内部类型、序列化和协议处理通过已安装源码确认，避免套用旧版 message/send 或 kind 字段示例。

角色服务采用官方 Express 集成，增加 express 5.2.1 和开发类型 @types/express 5.0.6；主 API 继续使用 Hono。这样角色侧直接复用官方 Agent Card 路由、版本协商、JSON-RPC 错误和 SSE 序列化，无需自行实现协议适配。初次接入发现当前 SDK 仅提供 fromJSON/toJSON，没有 fromPartial；也发现 agentCardHandler 返回 Router，必须用 use 挂载而不是 get。协议集成测试捕获了 Card 404，随后修正。

### 线上数据契约与发现如何设计？

Card 声明 JSONRPC、1.0、streaming 和单一 researcher/critic skill，输入输出为 application/json。消息使用标准 A2A data part；其中 version=1 是本项目的业务交接格式版本，input 包含 question/sources，以及 revision 或 draft，不是自定义 A2A 协议版本。

服务验证原问题最多 8000 字符、来源 1–8 段、每段最多 900 个 UTF-16 单位、RAG:1–8 唯一编号、哈希和读取时间；稿件最多 32000 字符，审查问题沿用最多 6 项。HTTP JSON 请求限制 128 KB。角色只拿到当前证据快照，不调用 MCP、数据库或检索工具；它们仍与用户进程同属本机信任域，并非操作系统权限沙箱。

发现使用 DefaultAgentCardResolver，Coordinator 校验预期角色 skill、JSON 输入输出、streaming、协议版本及接口 URL。只接受配置的 http://127.0.0.1:<port> origin 和对应 /a2a 接口，不跟随 HTTP 重定向，也不使用 Card 中的其他传输或地址。产物必须在 completed 后通过 GetTask 快照取回，验证唯一 JSON 产物及业务 schema；报告再次检查引用 ID，审查结果再次检查 approve/issues 一致性。

### 任务生命周期和产物如何表达？

服务端使用 DefaultRequestHandler、InMemoryTaskStore 和 AgentExecutor；先发布 submitted Task，再发布 working 状态消息，完成后发布 JSON Artifact 和 completed 终态。已知执行失败（包括输入、模型、产物验证失败）发布 failed，远端超时也以 failed 结束；错误消息脱敏。CancelTask 会中止角色 AbortSignal，并发布 canceled，避免后续结果覆盖取消状态。

研究产物是 report，Critic 产物是 verdict/issues/summary。Critic 返回 revise 仍是该审查子任务成功完成，由 Coordinator 决定是否修订；不要把业务上的否决等同于网络或协议失败。角色首次交接只支持新任务，不支持向旧任务继续追加对话；修订创建新任务。

A2A_TASK_CREATED、A2A_PROGRESS、A2A_ARTIFACT、A2A_COMPLETED 等事件进入现有主任务 SSE，页面“研究过程”可看到角色及远程任务 ID；草稿仍在通过 Critic 后才发布。角色任务在本服务内存中可查询，进程重启后丢失，未提前实现 M9 的持久化或恢复。当前无自动清理，长会话需要重启释放记录；无多租户隔离、文件传输或推送通知。

### 重试为什么不能直接重发 SendMessage？

提交失败时可能只是响应丢失，远端已经开始模型调用。客户端不会自动重发 SendStreamingMessage；未知任务 ID 时明确失败，不能宣称实现了 exactly-once。发现和 GetTask 属于只读操作，每次失败允许再试一次。

若流中断前已取得任务 ID，则改为轮询同一任务 GetTask，每 200 ms 查询，在任务完成后取完整产物快照，受 Coordinator 总截止时间约束。这可以恢复遗漏的事件和产物，不创建重复任务；不是执行 checkpoint 恢复，也不重放流事件。failed/canceled 等终态不会触发模型任务重试。

用户取消、Coordinator 超时或无法继续跟踪已知任务时，客户端尝试调用 CancelTask，使用独立 1.5 秒截止时间，因为原 AbortSignal 已可能取消。如果网络完全不可用或尚未取得任务 ID，无法保证即时远程取消；角色自身 MODEL_TIMEOUT_MS 是最后的执行上限。网络取消没有取消已完成工作或撤回产物的承诺。

### 配置与信任边界

A2A_ENABLED 默认 false，显式开启后要求 M6/M7 两个开关保持开启。原因是两个独立进程需要操作者启动和管理，不能让原来的 pnpm dev 静默依赖不存在的服务。A2A_RESEARCHER_URL/A2A_CRITIC_URL 默认 4101/4102；角色进程通过 A2A_PORT 改端口，每个进程可分别覆盖现有模型和时限变量。没有改写用户 .env。

服务只监听 127.0.0.1，限制 Host 并拒绝带 Origin 的浏览器请求；Card 的安全配置如实表示未启用身份认证。本地其他进程仍属于信任范围，不能把此配置直接暴露公网。若以后需要跨机器部署，应增加认证、TLS 和明确的租户/任务访问控制，而不是放宽当前 URL 限制后就宣称可安全远程运行。

### 自动化和真实演示

新增 8 个协议集成测试：启动两个真实独立 Node 子进程、真实 HTTP 与官方 SDK，仅替换模型执行。覆盖发现与完整委派、任务历史/产物查询、远端执行失败及超时、无效报告引用和审查产物、用户取消、Coordinator 超时后的远端 canceled、发现重试、断流恢复且执行计数只增加一次、未知提交结果不重发、恶意 Card/地址/Origin/空证据拒绝，以及主 Hono API 的成功和 A2A_FAILED SSE。测试替身在 test/fixtures 中，生产入口没有 fake 模式。前端组件测试增加 A2A 发现和进度事件。

普通测试 API 74 项、Web 6 项，共 80 项通过；2 项可选真实 PostgreSQL 集成测试本轮未运行，未计入 80 项。类型、lint、格式和构建通过。数据库 schema 与 SQL 未改。

真实角色进程 researcher PID 26769（4101）和 critic PID 26770（4102）分别使用本地 gpt-oss:20b，a2a:demo 读取 ADR 后经真正 Coordinator 完成两次委派、产物和审查通过：研究子任务 6ceb75e3-b893-433f-914a-399707ed9de9，审查子任务 5742a1c0-7c38-44ec-b183-1e4d7ae99a58。日志 /tmp/ai-research-m8-demo.log。

随后执行 a2a:demo --cancel，子任务 10885476-0960-49b8-80d6-af9ae1816455 在 working 后取消；通过官方 GetTask 独立查询，确认 state=5（canceled）、artifacts=0。日志 /tmp/ai-research-m8-cancel.log。这不是只中断前端等待。

主 API 临时运行于 3018，连接既有真实 PostgreSQL/embeddinggemma 和两个真实 A2A 角色服务。HTTP 任务 2b72b5f2-7197-4f27-823e-2b50ec01bafd 首轮本地检索命中 1 段；研究子任务 cbce1fe6-34d7-406d-9bf4-ba60b9465233、Critic 子任务 70954e62-590d-4710-805d-7b1fb6eb62e1 完成；事件 24 Coordinator 发布，25 才发送报告，26 AGENT_COMPLETED。日志 /tmp/ai-research-m8-http.sse。手工阅读了完整轨迹和带引用报告；未进行真实浏览器视觉验收，UI 通过组件测试。真实模型走首次审查通过分支，修订策略沿用 M7 的既有测试，不宣称 A2A 提高语义准确率。

最终补充检查 JSON part 的 mediaType 和 Card 输出模式，并重新通过全部 80 项测试与类型、lint、构建；格式和 git diff --check 通过。已关闭本轮 3018 API 及 4101/4102 角色进程，保留用户原开发服务、数据库与索引。README、step.md、docs/milestone8.md 和本文件同步更新；M8 等待用户验收，M9 尚未开始。

## 2026-10-10：Milestone 9，完整研究循环

### 本轮需求与范围

用户要求继续实现 M9。本轮按 step.md 的四项清单完成规划、研究、分析、批评、补充研究和报告，保留 M8 的远程角色接入。M9 请求意味着可以从 M8 推进；未开始 M10。

先澄清此前文档的时间安排：早期 ADR 和历史记录曾把持久化/检查点放在 M9，但实际 step.md 的 M9 清单是研究循环，M10 才明确提出持久化待处理请求与恢复。本轮实现请求内状态，不声称已经完成 PostgreSQL 任务保存或重启恢复。保留历史记录，并在 M9 文档和计划状态中明确未兑现的持久化部分。

### 为什么单独实现研究循环？

M7 的 Critic 只能让研究者在同一证据集合上修订，遇到缺少事实的情况，再次改写无法增加证据。新增 research/loop.ts，复用 M5 来源、M4 MCP、M7 ResearchAgents 和 M8 远程适配器。M6–M8 原工作流保留，可通过 RESEARCH_LOOP_ENABLED=false 回退。

LangGraph 节点分别为 planning、research、analyze、critique、publish。planning 返回最多三个子问题、工具路径、查询与公开理由；research 执行取证；analyze 由研究者整理草稿，再结构化分析；critique 检查报告；未通过或仍有未解决问题时回到 planning。下一次规划拿到问题、Critic issues、现有证据和查询历史，必须提出新的取证查询。首次仍使用原问题，避免过早关键词化。

LangGraph 不允许节点名与状态通道同名，首轮测试暴露 plan/report 的命名冲突后，节点改为 planning/publish。图 recursionLimit=16，同时有宿主轮次和预算约束，终止不依赖模型自觉。

### 怎样阻止循环把同一段资料反复包装？

每项任务最多 3 轮取证，其中本地最多 2 次、MCP 最多 1 次；最多累计 8 个片段。按稳定 chunkId 去重，请求内 RAG:1 等编号只追加、不重排。查询按能力分别进行 NFKC、大小写、空白规范化去重，首次零命中可改写再查，后续取证没有新增来源就停止，不再为相同证据付出一轮分析成本。

来源达到上限、能力不可用、查询为空或重复、轮次用尽都允许正常的“证据不足”终态。工具实际错误仍失败，不当成无命中。Critic 的 revise 和分析中的 unresolved 合并为下一轮缺证反馈；即使 Critic approve，只要还有未解决问题或没有任何有依据的条目，宿主仍不发布完整成功报告。这个标准偏保守，可能拒绝有用的部分答案，换取明确的完成条件。

### 报告怎样形成引用链？

分析模型返回 findings 和 unresolved。每个 finding 声明 observation 或 inference，包含正文及 1–3 组 sourceId/quote。宿主要求 sourceId 存在、quote 为 4–240 字符且逐字包含在对应来源内容中；不存在的来源、改写的引文或正文中混入引用标记都会导致失败。

报告由代码确定性渲染为“观察（原文所述）”“推断（需核验）”“未解决问题”，每条附引用编号和逐字原文。模型起草内容只是分析材料，不新增证据；Critic 收到的是即将发布的结构化报告文本及同一份原文快照。交给角色的来源深拷贝，防止进程内角色意外修改共享证据。

前端在原有纯文本报告中只把已知 [RAG:n] 转为来源锚点，点击后展开并定位原文 details；没有新增通用 HTML 或 Markdown 执行。引用链是“报告条目 → 引文 → 请求内编号 → 稳定片段/文档哈希/行号/原文”。精确引文证明文本存在，不证明其逻辑支持结论，也不能阻止断章取义，Critic 和语义评测仍有必要。

### token 和成本预算怎样落地？

每项任务最多 12 次模型调用，包含计划、研究草稿、结构化分析、Critic、MCP 文档选择和允许的重试。ResearchBudget 包装本地 ModelProvider，调用前预留 UTF-8 prompt 字节、两份 schema 字节、2048 固定开销和 4096 输出额度。远程研究/审查无法读取内部 prompt，因此按现有输入契约每次预留 200000 单位；任务总预留上限为 1600000。预算不足时不发起下一次调用，返回明确停止说明。预留不在失败后退还，避免重试逃过预算。

该计数是保守的文本与调用预算，不是精确 tokenizer 统计、服务商 usage 或美元账单。没有伪造真实成本金额。embedding 仍单独受检索次数约束，A2A 只读轮询仍受截止时间约束；预算事件不把这些网络操作计为生成模型调用。模型价格、服务商隐藏 prompt 和 tokenizer 会影响实际费用，因此没有美元限额保证。

为真正限制单次输出，统一模型适配器向已安装官方 SDK 发送 Ollama options.num_predict=4096 和 OpenAI max_output_tokens=4096；所有模式包括 M8 独立角色都会使用该限额。核对了本地 SDK 类型及 OpenAI 参数说明中包含推理 token 的上限语义。达到限额的 Ollama 输出、OpenAI incomplete 响应及未完成流不当作完整成功报告。适配器测试检查发出的参数和截断失败；没有根据“估计字数”冒充服务端 token 限额。

### 失败、取消、时限和 A2A 如何复用？

本地非流式模型 MODEL_PROVIDER_ERROR 最多额外重试一次，重新预留预算；格式错误、工具失败和流式调用不重试。远程角色提交继续沿用 M8 的不重发原则，断流只查询原任务；M8 的只读传输重试与本轮一次模型重试是不同层次。

整体 MODEL_TIMEOUT_MS 与 AbortSignal 覆盖循环、工具、分析和 Critic；远程调用仍由 A2A 取消逻辑负责尽力取消已知任务，不能保证网络断开时即时停止。草稿不会通过 REPORT_DELTA 发送，只有发布节点的最终报告或停止说明才发送。模型/协议/引文验证异常保留 failed，预算和证据不足则 completed 携带明确 outcome，二者不混淆。

### 配置与测试

运行入口默认 RESEARCH_LOOP_ENABLED=true，只有 AGENTIC_RAG_ENABLED 和 MULTI_AGENT_ENABLED 同时启用时生效；A2A_ENABLED 的选择保留。工厂默认参数保持旧测试兼容，用户 .env 未改。简洁运行说明在 docs/milestone9.md，并同步 README、step.md 和 M8 文档。

新增 16 个循环测试，覆盖固定研究题的计划、缺证补查、稳定引用编号、Critic approve 仍有未解问题、伪造来源/引文、重复查询、无新增证据、空命中补查、本地和总轮次上限、来源上限、预算耗尽、唯一重试、直接回答、工具/审查失败、取消/HTTP 超时以及本地角色调用计费计数。增加 1 项 M9 与两个真实 A2A 子进程的 HTTP 集成测试；SDK 增加 2 项截断测试，前端补充计划事件与引用定位断言。共 API 93 项、Web 6 项，99 项通过；2 项可选 PostgreSQL 测试本轮未重复运行，未计入该总数。类型、lint 和构建通过。

### 真实成功路径

临时 3019 API 使用真实 Ollama gpt-oss:20b、embeddinggemma 和已有 PostgreSQL，A2A=false。问题限定为 ADR 中 PostgreSQL/pgvector 的两条选型理由，不要求实测或实施状态。任务 e79929a2-7781-4afe-bf30-322c1a8d63a6 检索得到 3 个片段，结构化生成 2 条观察，逐字引文验证和 Critic 均通过；LOOP_COMPLETED 显示 4/12 次模型调用、45963/1600000 预留单位。事件 14 才发报告，15 AGENT_COMPLETED，日志 /tmp/ai-research-m9-success.sse。手工核对了原文引文和最终分组。

本轮真实模型验证使用进程内角色；远程 M9 通过两个真实 A2A 服务进程、替换模型的集成测试验证。没有把这两种验证混称为真实远程模型全链路。前端引用定位通过组件测试，未进行本轮浏览器视觉验收；未调用真实 OpenAI，未测实际付费账单或质量提升幅度。

### 缺证题的真实失败记录

首次以“这个项目的检索延迟具体是多少毫秒？请提供实测数据，不要推测。”测试，取证得到 2 段资料，研究草稿通过引用编号检查，但分析生成了无法在来源中逐字匹配的引文。任务在事件 9 以 MODEL_INVALID_OUTPUT 失败，没有 REPORT_DELTA 或成功终态，日志 /tmp/ai-research-m9-insufficient.sse。没有放宽引文约束或把这次失败称为正常的证据不足完成。

这也说明现有模型复制引文仍会出错，结构校验不能保证模型总能生成有效结果。随后用更明确的“如无实测值，不写背景知识或规划，只列缺少的证据”重新提交，单独检查正常缺证终态；这不是应用中的隐藏自动重试。自动化已覆盖缺证反馈再检索和停止分支，真实行为需分别记录。

### 真实缺证循环与收尾

更明确的缺证任务 7491add8-3456-41e8-ac64-7034b8b91f12 完成了预期闭环。首轮本地命中 1 段，分析生成 1 条可定位引文；Critic 指出来源不含延迟信息、结论缺乏支持。事件 12 用反馈重新规划，13 发起第二轮本地检索，14 确认新增 0 段；发布节点返回“证据不足：补充研究未取得新证据”及测量数据、分位数、实验日志等缺少证据清单，没有发布被否决的草稿或虚构毫秒数。模型调用 5/12 次，预留 44374/1600000 单位，最终 AGENT_COMPLETED 序号 18。日志 /tmp/ai-research-m9-insufficient-clarified.sse。

这条真实轨迹验证了 Critic 反馈确实触发取证，不只是再次润色文本。首次错误引文失败与后续正常缺证完成分别记录，未隐藏模型不稳定性。已关闭本轮临时 3019 API，保留用户数据库和已有开发服务。格式检查与 git diff --check 通过，step.md 和运行文档同步标记 M9 已实现、等待用户验证；M10 未开始。

## 2026-11-06：对照 Hello-Agents 第十四章

用户要求比较当前项目与 Datawhale 第十四章的研究 Agent，并判断可迁移技术。本轮只做代码与章节静态审查，没有修改业务实现或启动 M10；保留 app.ts 原有空行修改。读取章节网站实际 Markdown（https://hello-agents.datawhale.cc/chapter14/第十四章%20自动化深度研究智能体.md），核对 14.2 TODO、14.3 顺序协作、14.4 搜索与笔记、14.5 搜索缓存及前端章节。未运行对方项目，也未把章节示例视为其最新仓库完整实现。

核心差异：教程主要是面向互联网的多 TODO 搜索、子任务总结和报告汇总；当前项目是面向本地资料的有界 LangGraph 研究/分析/Critic 闭环，可选真正 A2A 独立角色。当前 planning.questions 只是提示与展示数据，没有独立子任务 ID、状态、检索证据归属或覆盖率；它不能等同于教程逐项执行的 TODO 计划。当前报告逐条验证来源 ID 和逐字引文，且带稳定片段、哈希、位置映射；教程强调来源 URL 和引用，但展示的代码未见同等宿主语义外的严格引文校验。当前无任务持久化，pgvector 保存的是资料索引；教程 NoteTool 保存 Markdown 研究记录，这有审计价值，但仅存笔记不能证明具备事务性断点续跑。

教程展示的三个服务是顺序协作、明确无并发，不能当作已实现并行研究或真实跨进程协议的证据。章节引言提到反思，但 14.3.3 展示的主协调流程是规划→逐项搜索/总结→报告，不能据此认为有当前项目这种显式 Critic 回到新一轮检索的图。

建议优先级：首先把 questions 升级为持久化 ResearchTask（id/title/intent/query/status/evidenceIds/summary/gaps），保留共享证据库和全局预算，并让 Critic 把问题绑定到子任务；成功子任务可保留，缺证子任务单独补查，改善当前一个 unresolved 就阻止全部成功报告的问题。其次借鉴 NoteTool 的研究笔记思想，使用已有 PostgreSQL 保存任务、证据快照、结果和事件；Markdown 仅作为导出，不作为唯一恢复依据。这与 M10/M11 的持久化、审批与历史回放衔接。若目标扩展到开放域研究，再加入 SearchProvider/网页正文采集，保存 URL、标题、抓取时间、正文哈希和来源类别；网页快照复用现有分块/引文校验，不将搜索摘要或模型答案当成已核实全文。

可随后迁移搜索缓存、子任务进度视图和报告按任务汇总。缓存键包含 provider/query/参数，补充 TTL、刷新和来源时间；章节缓存示例未展示过期机制。保留当前异常与空命中区分，不照搬搜索服务 catch 后返回空数组；不迁移文本 TOOL_CALL 标记解析、字符数乘四冒充精确 token、纯提示词引用保障，也不为此更换 TypeScript/Hono/LangGraph 为 Python/FastAPI/HelloAgents。框架改写没有直接填补能力缺口。

建议实施顺序：子任务与证据映射→持久化及恢复契约→可选联网搜索与快照→缓存和进度展示。验收关注子问题覆盖率、引用正确率、取消/重启不重复执行、缓存时效和全局预算；并行不是本章已经证明有效的迁移项，需后续有评测再决定。本轮未重跑历史测试，不把历史 99 项结果当作当前重新验证结果。


## 2026-11-06：Milestone 10 人工介入与持久化恢复

用户要求继续完成 M10。本轮实现主动澄清、首轮计划、补充计划以及 MCP 文档访问审批，未提前开展 M11。保留 M9 默认行为，使用 HUMAN_ENABLED=true 显式开启；用户现有 .env 未修改。开发者操作说明放在 docs/milestone10.md，详细决策在此记录。

### 为什么采用节点快照

沿用已有 LangGraph 研究循环，增加节点执行前后钩子，在 PostgreSQL 中保存版本化状态、下一节点、执行阶段、来源快照、模型调用次数、文本预留单位、重试次数及累计执行时间。没有重新实现一套研究算法，也没有将整个图从起点重跑来模拟恢复。审批暂停点位于规划结果持久化之后、取证之前；批准读取已保存计划并直接进入取证，修改查询也不重新调用规划模型。累计模型预算和执行时间跨审批保存，人工等待时间排除，批准不能重置预算。

选择显式应用层快照，是为了把研究状态、审批决定和审计放在同一数据库事务中，同时清晰规定外部调用的恢复边界。当前没有接入 LangGraph 通用 checkpointer，也不声称支持任意节点内部恢复。快照包含 version，运行配置指纹用于阻止不同模型、工具或关键配置下直接恢复；后续状态结构升级仍需显式迁移。

### 如何防止重复执行和并发决定

human_tasks 保存任务及访问密钥哈希，human_audit 保存操作人、时间和决定。事务内 SELECT FOR UPDATE 将状态变更与审计原子提交；审批 ID 校验阻止旧页面和重复批准，并发批准/拒绝只有一个成功。任务执行使用 owner 和有期限的租约阻止重复启动。批准后若进程在启动前退出，ready 状态可由恢复接口继续。

节点调用前写入 inflight，完成后写入 ready 快照。若进程在外部调用和结果落库之间退出，无法证明外部副作用是否发生；租约到期后的恢复将其标为 interrupted，要求新任务，不自动重放。只有持久化的节点间状态可恢复。这是保守的防重复策略，不是分布式 exactly-once，也不包含未知远程结果的自动补偿。当前 MCP 仅访问可信目录的本地 Markdown，没有写入或真正高风险工具；未来新增工具必须另定授权和幂等契约。

### 授权、澄清及页面取舍

创建任务返回随机访问密钥，数据库只保存 SHA-256 哈希，后续查询和决定必须携带 x-research-key。审批模式 API 绑定回环地址，路由检查本机 Host/Origin，并禁止原 SSE 入口绕过审批。操作人由用户自报，仅是审计标签，不伪装成认证身份；当前不是多用户权限系统。浏览器 localStorage 保存当前任务入口，刷新后可继续，清除存储则失去该入口。审批默认 24 小时有效，查询或决定时惰性检查过期并记录审计，无独立定时扫描服务。

主动澄清由提交时复选框触发，用户可修改问题后批准；后续计划允许修改查询，并检查是否与已执行查询重复。页面展示背景、子问题、理由、过期时间、来源详情和审计，支持批准、拒绝及恢复。暂用轮询读取持久化状态，完整事件历史、SSE 重连和任务图仍属于 M11。

### 验证及真实模型限制

pnpm format、typecheck、lint、test、build 全部通过；普通测试 API 102 项、Web 9 项，共 111 项，另外 3 项数据库测试默认跳过。另行指定 TEST_DATABASE_URL 运行新增真实 PostgreSQL 测试 1 项成功，因此本轮共验证 112 项，未把跳过的旧数据库用例计入成功数。

新增测试覆盖暂停后批准、查询修改、不重复规划、主动澄清、拒绝、过期、旧审批、错误密钥、MCP 审批、补充计划、重复查询阻止、执行租约、配置变化、未知执行结果不重放，以及跨审批累计执行时间耗尽。PGlite 测试实际关闭并重新打开磁盘数据库，验证恢复；真实 PostgreSQL 测试验证并发决定互斥以及重新连接后的持久化。前端组件测试覆盖刷新恢复审批、修改查询、拒绝及过期隐藏操作。

临时 3020 API 使用真实 PostgreSQL、Ollama gpt-oss:20b 和本地 embedding，A2A=false。任务 a22ce465-2734-480f-abfe-bdd8a5debed1 在首轮规划后暂停；停止并重新启动 API 后，原审批与 research 快照仍在。批准后审计从 approved、started 直接进入 node_started research、node_completed research，再进入 analyze，没有第二次 planning，验证了真实进程重启后的恢复边界。

该真实任务随后在 analyze 阶段失败，未发布报告。当前审计保存通用失败信息，不能仅凭此确定是输出格式、引文还是模型服务问题，因此不归因于某一未证实原因，也不把它算作真实模型完整成功路径。完整批准至报告路径由确定性模型测试覆盖；本轮未进行浏览器视觉验收、真实 OpenAI 或真实远程 A2A 模型验收。保留该质量与诊断限制，未放宽 M9 引文校验。关闭本轮临时 API，保留原数据库及用户服务，等待用户验证 M10。

## 2026-11-06：LangGraph 节点、边与状态定位

用户询问项目中 node、edge、全局状态的位置。当前完整研究循环集中在 apps/api/src/research/loop.ts：Annotation.Root 定义每次图运行的共享状态，addNode 定义规划、取证、分析、审查、发布，addEdge/addConditionalEdges 定义流转，graph.invoke 初始化或恢复状态。状态是单次任务范围而非所有用户共享的进程全局变量；预算和依赖是图外对象。M10 在 human/service.ts 将图状态和预算等保存到数据库快照。早期 workflow.ts、agentic.ts、review.ts 也各自定义独立的图和状态。本轮只解释代码，未运行测试。

## 2026-11-06：LangGraph 项目阅读指南

用户希望用通俗语言结合 LangGraph 解释项目整体流程与细节，文档引用文件、行范围或方法名，不直接粘贴代码块。本轮新增 docs/langgraph-code-guide.md，以当前完整研究图为主线，覆盖启动和模式选择、状态/节点/边、模型预算、RAG/MCP、审批快照与恢复、A2A、旧图和一次任务示例；明确共享状态作用域、引用校验及恢复限制。仅新增说明，未修改业务代码；行号可能随代码演进变化，方法名可用于重新定位。

## 2026-11-06：为研究循环添加注释

用户要求在 loop.ts 中添加详细注释。本轮用中文解释状态和快照、节点钩子、五个节点、引用校验、预算及条件边，提醒路由与恢复计算同步维护；仅添加注释，不改变行为。

## 2026-11-06：细化研究循环逐步注释

用户要求进一步解释 loop.ts 中每个逻辑步骤的作用与原理。本轮补充状态字段分组、规划校验、查询去重、取证、预算、结构化分析、逐字引文、审查条件、路由及异常处理注释；只修改注释，不改变行为。

## 2026-11-06：人工审批服务注释

用户要求为 service.ts 添加详细注释；结合上下文，选择 apps/api/src/human/service.ts，解释任务启动、事务与租约、节点快照、审批暂停、恢复预算、错误处理及执行权校验。仅增加注释，不修改业务逻辑。

## 2026-11-06：M11 与联网搜索（进行中）

用户要求实现 M11 并加入联网搜索。检查发现普通 SSE 连接断开后任务取消且无历史，人工模式仅保存节点审计，不能直接宣称支持断线续传。Brave Web Search 官方接口需要服务端 API 密钥；搜索摘要不应冒充网页原文。先在人工审批界面增加节点及累计预算展示、轮询失败后自动重试；尚未实现持久化事件补载、SSE 重连、联网搜索和完整 M11。后续需明确来源元数据及网页内容抓取边界、保留审批和预算，并完成测试。

## 2026-11-06：继续 M11 与 Brave 搜索

本轮接入 BraveSearch 到完整研究循环及人工审批服务，web 最多两次，共享三轮取证和八段来源；凭证只在 API。搜索结果保存 URL、标题、摘要时间及哈希，明确是搜索摘要，未冒充已抓取的网页全文，也未自动请求结果 URL。工具和联网访问审批在取证前执行，配置指纹包含搜索是否启用。

研究事件及 A2A 进度写入现有事务审计；新增带访问密钥的有限批次 SSE 接口，按 after 或 Last-Event-ID 补载。页面按游标刷新补载并失败重试，显示节点、预算、事件详情和外链。普通请求式 SSE 保留原语义；持久化过程体验使用人工模式。本轮未获得真实 Brave 密钥，不能声称真实联网验收成功；未进行浏览器视觉验收。新增搜索适配器测试，完整类型、lint、测试和构建检查执行；M11 的长任务与真实浏览器综合验收仍待完成。

## 2026-11-06：搜索配置未生效排查

用户修改 .env.example 后模型仍不搜索。检查确认启动入口仅加载工作目录的 .env，当前搜索和人工模式开关及 Brave 密钥填写在 apps/api/.env.example，而实际 apps/api/.env 未包含这些配置。.env.example 仅为模板，不自动加载。应将对应项合并到 apps/api/.env 后重启 API，保留已有模型设置；不用覆盖整个文件。联网开启后仍由规划决定是否选择 web，并需要批准查询。检查过程中未输出密钥值，未修改用户凭证或运行配置。

## 2026-11-06：M11 终端式对话与审批界面

用户要求参考 Codex 的终端工作台风格设计前端。本轮采用浅色等宽字体、路径/连接状态栏、用户问题与执行事件对话流、内嵌审批卡片及底部任务输入；不引入额外 UI 框架。保留来源展开、引用跳转、预算和原始事件详情，支持窄屏、键盘焦点和减少动画偏好。对话显示真实任务事件，当前没有承诺多轮聊天能力。

新增 SSE 补载事件进入对话并显示审批的组件测试；已有批准、拒绝、修改查询和刷新恢复测试通过。类型、lint、Web 测试及构建通过。尝试用 Edge 原生 UI 预览时页面刷新后捕获为空，未能完成可靠的视觉验收，不能将其计为通过。启动本地 pnpm dev 供用户预览。M11 综合验收仍保留进行中。

## 2026-11-06：反复执行失败诊断

用户询问通用失败是否需要调高阈值。查询最近四个持久化失败任务，三个停在 analyze，一个停在 critique；已有审计丢失原始错误，不能直接归因全部历史任务。使用最近任务保存的问题与来源，在真实 Ollama gpt-oss:20b 上单独重放只读研究者调用，复现 MODEL_INVALID_OUTPUT：草稿缺少或包含未知片段引用。该调用使用 120 秒中止上限，实际返回引用校验错误，因此这次失败不是检索阈值或总时间耗尽。没有调高检索阈值，也没有放宽引用校验。

修正旧研究者提示词中“未进行网页搜索”的矛盾表述，说明宿主可能提供网页摘要。人工服务失败记录新增错误码、节点及针对 token 截断、引用、逐字引文和结构化输出的安全说明，不保存原始 SDK 错误或凭证。新增无引用草稿回归测试确保原因可见且不发布报告。提示词修改后未证明真实模型一定成功；历史 critique 失败原因仍不能从旧通用审计恢复。当前 .env 总时限为 60000，只有出现明确超时才建议提高；单次 token 上限和 schema/引用约束不能混同检索阈值。

## 2026-11-06：改为报告优先、核验结果显式展示

用户指出本地模型经常缺少引用，要求先输出报告并标明不确定内容。本轮更正先前严格阻止报告的产品决策：完整研究循环的本地研究者允许保留引用不完整草稿，未知引用去掉可点击引用格式并标注无效；生成后通过 REPORT_PREVIEW 持久化展示“初稿、尚未完成核验”。结构化分析或引文校验失败时保留草稿并标为待核验，审查输出无效或补查结束时仍发布带缺口说明的报告。成功通过校验的路径保留原引用与审查流程。没有放宽引文匹配规则，而是将校验失败作为报告质量状态；普通早期工作流保持默认严格选项。

超时、取消和服务异常仍作为执行错误，已持久化的预览可供用户阅读。若初始规划或研究者完全未生成文本，仍无法凭空提供报告。未知引文和结构化无效不会伪装为审查通过。更新原先期望引用失败即拒绝的测试，保留规划错误、工具失败、预算与取消边界检查。

## 2026-11-06：终端输出区与固定操作区

用户明确要求主内容只显示信息并自动滚到底，不应向上寻找操作。本轮重新组织 HumanResearch：固定视口，输出区独立滚动且只包含文本、事件、报告及来源原文；移除输出区的折叠按钮和引用跳转。底部固定审批、恢复、刷新和新研究输入，pending 时隐藏新任务表单，审批保持可见。新增内容、报告和状态变化时滚到输出底部，普通重复轮询不触发滚动。来源直接展示，避免展开操作。更新组件测试检查输出区没有交互控件且批准按钮在底部。纯普通流页面保留可滚动布局。本轮尚未完成浏览器视觉验收。

## 2026-11-12：RAG 文档上传

用户要求前端上传并在研究中使用，优先现成包。核对现有依赖和 Hono 官方文件上传文档后，复用已安装 Hono 的 parseBody、bodyLimit 与浏览器 File/FormData；文本无需额外解析器，未手写 multipart。首版 UTF-8 Markdown/TXT，单文件 24 KB，与现有资料限制一致；未声称支持 PDF/Word。上传在底部操作区，索引成功后才添加下一次问题的资料提示，失败显示原因。内容进入本机共享知识库，非会话隔离附件，使用依赖模型选本地和相关性阈值。

复用分块和 embedding，增加事务化向量追加，锁定索引并验证 embedding 配置，重复内容使用稳定哈希去重，不覆盖既有文档。服务端拒绝超限、不支持格式、空或非法编码和非本机来源。上传原始文件不落盘；全量 CLI 摄取仍替换整个索引，此限制已在文档说明。新增上传→索引→检索、去重、格式及来源拒绝测试，以及前端成功与失败测试。
