# 从 LangGraph 理解项目代码

本文按当前 M10 实现讲解，从一次用户请求出发，逐层追到图、模型、资料和数据库。路径均相对于项目根目录；行号用于定位，方法名比行号更适合代码变化后的搜索。建议一边打开对应文件一边阅读。运行配置与命令见 [M10 操作说明](milestone10.md)，本文侧重代码如何工作。

## 1. 先建立一张地图

把研究任务想成一份在办公室流转的工作单：用户提出问题，规划员决定要找什么资料，研究员取证并分析，审查员检查，不够就退回补查，最后输出报告。LangGraph 的**图**规定工作单能经过哪些步骤，**节点**完成具体步骤，**边**决定下一站，**状态**是随工作单传递的数据。

这个比喻对应项目中的不同层次：

| 概念 | 代码里的对应物 | 作用 |
| --- | --- | --- |
| 图的状态定义 | `apps/api/src/research/loop.ts` 的 `State = Annotation.Root(...)`，44–58 行 | 定义工作单有哪些字段 |
| 图实例 | 同文件的 `new StateGraph(State)`，152 行起 | 将状态、节点与边组装起来 |
| 节点 | `addNode`，153–388 行 | 执行规划、取证、分析、审查、发布 |
| 边 | `addEdge` / `addConditionalEdges`，389–415 行 | 固定或根据状态选择下一步 |
| 编译 | `.compile()`，416 行 | 得到可以执行的图 |
| 一次执行 | `graph.invoke(...)`，419 行起 | 提供初始或恢复状态，运行图 |
| 图外的持久化 | `apps/api/src/human/service.ts` 的 `HumanService` | 在节点边界保存、暂停及恢复 |
| 图外的能力 | `model/`、`rag/`、`mcp/`、`a2a/` | 让节点调用模型、检索资料或委派角色 |

注意：目录中的 `workflow.ts`、`agentic.ts`、`review.ts` 也各有一张图。它们是早期能力和可回退路径，**不是**当前主图的五个节点拆到不同文件。`review.ts` 同时提供主图复用的研究者和 Critic 接口。

## 2. 用户请求先到哪里

1. 浏览器入口 `apps/web/src/main.tsx` 加载 `App.tsx`。`App` 调用健康接口，依据返回的 `humanEnabled` 选择普通表单 `ResearchForm` 或审批表单 `HumanResearch`。
2. 服务启动入口 `apps/api/src/index.ts` 读取环境变量，创建模型 provider、可选 MCP 工具、可选 RAG、可选 A2A 地址和可选人工审批服务，再交给 `createApp`。
3. `apps/api/src/app.ts` 的 `createApp` 挂载研究、RAG、健康和模型接口。人工审批启用时挂载任务接口，并阻止普通研究流入口绕过审批。
4. 普通模式下，`ResearchForm.submit` 请求 `/api/research/stream`；`apps/api/src/research/routes.ts` 的 `researchRoutes` 校验问题、建立 SSE 和超时信号，选择工作流。事件包括任务 ID、递增序号、时间和类型；`apps/web/src/research-stream.ts` 的 `readResearchStream` 解析流，表单更新进度与结果。断开或取消会传播中止信号。
5. 人工模式下，`HumanResearch.send` 访问 `/api/research/tasks` 系列接口，页面定期查询任务；它走持久化审批流程，具体见第 8 节。

**如何选择图？** 见 `index.ts` 中传给 `createApp` 的标志，以及 `research/routes.ts` 中 `loop ? ... : agentic ? ... : ...`：完整循环要求 `RESEARCH_LOOP_ENABLED`、`AGENTIC_RAG_ENABLED`、`MULTI_AGENT_ENABLED` 都为 true；否则启用 Agentic 时用 `runAgenticResearch`，再否则用 `runResearch`。Agentic 路径中的多角色审查由 `multiAgent` 决定。模型未配置时研究请求无法执行。RAG、MCP 和 A2A 能否使用还分别受配置控制，不等同于图是否启用。

## 3. LangGraph 状态到底是什么

看 `loop.ts` 的 `State` 定义和 `graph.invoke` 初始值。每运行一个研究任务，图维护该任务自己的状态；节点读取它并返回要更新的字段。未返回的字段继续保留。这里各字段没有自定义 reducer，因此不要将它理解成自动追加的共享列表；需要追加时节点自己构造新数组。状态不是跨用户、跨请求共享的全局变量。

| 字段 | 含义及何时变化 |
| --- | --- |
| `plan` | 当前 action、query、reason、questions；由 planning 更新。questions 是规划提示，并非独立执行的子任务队列 |
| `sources` | 已收集的证据片段；research 去重追加并分配稳定的 `RAG:n` 编号 |
| `queries` | 已执行查询的归一化记录，含工具类别；用于阻止重复查询 |
| `round` | 已完成的取证轮数；research 完成后增加 |
| `localCalls`、`mcpCalls` | 两类取证各自的使用次数 |
| `draft` | 当前分析渲染出的报告草稿；不是未经审查即可发布的结果 |
| `analysis` | 结构化的观察、推断、引文和未解决问题 |
| `issues` | 需要补充或修正的问题，供下一次 planning 使用 |
| `approved` | 是否满足发布条件，由 critique 更新 |
| `stop` | 主机程序决定停止的原因；非空时后续走发布/不足路径 |
| `report`、`outcome` | publish 节点产出的最终文本与结果类型 |

原始 `question`、模型 provider、工具对象、中止信号和 `ResearchBudget` 是 `runResearchLoop` 的参数或局部对象，并不全放在图状态里。状态类型 `LoopState` 从 `State.State` 推导；`LoopSnapshot` 则把状态连同下一节点、阶段和预算一起保存，见 `loop.ts` 的 59–84 行。区分**图状态**、**节点返回的更新**和**持久化快照**，阅读恢复逻辑会容易很多。

## 4. 主图逐节点阅读

### planning：先决定下一步

位置：`loop.ts` 的 `addNode("planning", ...)`，约 153–210 行。

它把原问题、已有证据、审查意见、查询历史、轮数和可用工具交给模型，要求按 `planSchema` 输出 action、query、reason 和最多三个子问题。首次选择 local/MCP 时，宿主将查询设置为原问题。模型只提出建议：宿主还会检查轮次、来源数量、工具是否可用、调用次数、空/重复查询，以及取证后不能再退回无来源直接回答。问题是简单问候或对给定文本改写时，初始轮可以选择 `direct`。结果写入 `plan` 和 `stop`，并发出 `LOOP_PLAN`。

### research：获取证据

位置：`loop.ts` 的 `addNode("research", ...)`，约 211–257 行。

根据 plan 选择本地向量检索或 MCP 文档读取；MCP 返回的文档还会切成片段。节点按片段 ID 去重，把新来源加入现有 `sources`，分配 `RAG:1` 等引用编号，记录查询并增加轮次及对应调用数。来源最多八段。补查没有增加证据时设置停止原因；首次没有证据则记录缺证问题，允许图尝试重新规划。它发出检索开始和完成事件。

### analyze：从证据整理出可核对的结论

位置：`loop.ts` 的 `addNode("analyze", ...)`，约 258–318 行，及 `renderAnalysis`。

先调用研究者生成草稿，再调用模型按 `analysisSchema` 提取结构化结论：观察、推断和未解决问题。每条结论需要来源 ID 和逐字引文。宿主检查来源 ID 存在、引文确实出现在对应片段、文本没有混入不合规范的引用标记；校验失败直接报错，不发布草稿。通过后 `renderAnalysis` 将结构化结果渲染为可读文本。逐字匹配只能证明引文出现在来源中，不能单独证明结论语义正确，所以还要审查。

### critique：审查并决定是否补查

位置：`loop.ts` 的 `addNode("critique", ...)`，约 319–367 行；角色契约在 `review.ts` 的 `ResearchAgents`、`reviewSchema` 和 `createResearchAgents`。

Critic 收到问题、复制后的证据和草稿，返回 verdict、摘要和问题。宿主检查通过时不能带问题、要求修改时必须有问题，然后合并模型列出的未解决问题。只有 Critic 通过、至少有一条结论且没有未解决问题，`approved` 才为真。否则边会回到 planning，尝试针对缺口检索，而不是简单重写同一份答案。

### publish：明确结果

位置：`loop.ts` 的 `addNode("publish", ...)`，约 368–388 行。

初始直接回答会标明没有检索资料；已批准则返回草稿；其他情况返回证据不足及未解决问题，不发布未经批准的草稿。模型调用预算耗尽在 `runResearchLoop` 外层捕获，返回预算耗尽的不足结果；其他错误和取消按调用路径传递。

## 5. 边如何让流程循环

`loop.ts` 的边和 `nextNode` 是两处需要一起读的代码：前者供 LangGraph 路由，后者给持久化快照记录下一站；修改路由时必须同步两处。

| 当前节点 | 条件 | 下一站 |
| --- | --- | --- |
| START | 新任务 / 有恢复快照 | planning / 快照中的下一站，或 END |
| planning | 停止或直接回答 / 需要取证 | publish / research |
| research | 停止 / 有来源 / 无来源 | publish / analyze / planning |
| analyze | 总是 | critique |
| critique | 已通过 / 未通过 | publish / planning |
| publish | 总是 | END |

回到 planning 不等于无限循环：规划检查最多三轮、最多八段来源；本地最多两次、MCP 最多一次；重复查询和补查无新增证据也会停止。`graph.invoke` 还设有递归限制。节点抛错时不会沿普通边继续。

## 6. 图外的模型、预算和超时

`apps/api/src/model/types.ts` 的 `ModelProvider` 是统一接口，提供普通生成、流式生成和结构化输出；`model/config.ts` 根据配置选择 `ollama.ts` 或 `openai.ts`。`planSchema`、`analysisSchema`、`reviewSchema` 是 Zod 结构约束，既限制模型返回形状，也供宿主验证；结构正确不代表事实正确。

`research/budget.ts` 的 `ResearchBudget` 包装 provider：默认最多 12 次调用、1,600,000 文本预留单位；一次输出上限是 `model/types.ts` 中的 4096 token。预留单位基于输入字节及输出额度，**不是实际 token 用量或费用**。远程角色调用按固定预留量计入，非流式暂时性 provider 错误最多重试一次，流式部分输出不重放。具体计数方式看 `reserve`、`remote`、`wrap`。

`model/deadline.ts` 提供 deadline 和 `raceWithAbort`。普通 SSE 请求将客户端断开和总时限传播下去；人工模式在 `HumanService.execute` 中扣除已用执行时间。模型、数据库或外部调用失败并不自动变成可信报告。

## 7. 资料从哪里来

### 本地 RAG：先建索引，再查询

- `rag/ingest.ts` 是摄取入口；`rag/config.ts` 组装服务。
- `rag/service.ts` 的 `RagService.ingest` 读取资料、调用 `rag/chunks.ts` 的 `chunkDocument` 切块，交给 `rag/embedding.ts` 的 embedder 生成向量，再通过 `rag/store.ts` 的 `VectorStore.replace` 存储。
- 用户研究时，`RagService.retrieve` 对查询生成向量，调用 `VectorStore.search` 做相似度检索并返回片段。数据库配置在 `rag/database-config.ts`；PostgreSQL/pgvector 保存的是文档索引，不是自动拥有研究任务恢复能力。
- 片段带文档、位置及标识；主图另外分配展示用 `RAG:n`，所以最终引文能回到具体来源。

### MCP：通过工具读取本地文档

`mcp/client.ts` 的 `McpDocumentTools.collect` 启动并调用 MCP 文档服务；`mcp/server.ts` 注册工具；`mcp/documents.ts` 的 `listDocuments`、`readDocument` 限定可读取的 Markdown 文档及路径。主图的 MCP 路径读取文档后再切块；它不是互联网搜索，也不是写文件工具。是否启用由 `MCP_ENABLED` 和文档目录配置决定。

## 8. 人工审批与恢复：图外包一层

从 `human/routes.ts` 到 `HumanService` 再到 `HumanStore` 阅读：

1. 创建接口校验问题和操作人，`HumanStore.create` 写入任务、创建审计并返回随机访问密钥。选了主动澄清就先生成 clarification 审批，否则 `HumanService.start` 启动后台任务。
2. `start` 检查配置指纹、状态和执行租约，取得 owner；`execute` 调用同一个 `runResearchLoop`，并传入 before/after hooks。
3. `loop.ts` 的 `durable` 在每个节点前执行 before，完成并合并更新后执行 after。`HumanService.execute` 的 before 保存 `inflight`；after 保存 `ready` 状态、下一节点、累计预算和执行时间。
4. planning 完成且下一步是 research 时，after 创建审批、将任务设为 pending，再通过内部 `Paused` 中断此次图执行。首轮计划、补充计划和 MCP 访问各有对应审批类型。直接回答或停止不进入这个取证审批点。
5. 用户批准或拒绝时，`HumanStore.decide` 检查审批 ID、有效期和状态；批准可修改澄清问题或查询。批准后设为 ready 并再次 `start`，从快照记录的 research 节点继续，不重新规划。拒绝后结束；过期在查询或决定时检查。
6. `HumanStore.change` 以数据库事务和行锁把状态修改与审计一起提交；旧审批和并发决定会冲突。`human_tasks` 保存任务 JSON 和密钥哈希，`human_audit` 保存操作记录。`HumanResearch.tsx` 保存任务 ID/密钥于浏览器，并轮询状态、展示审批和来源。

状态含义见 `human/store.ts` 的 `Status`：queued 等待启动、running 执行、pending 等待审批、ready 可继续、completed 完成、failed 失败、rejected 拒绝、expired 过期、interrupted 表示执行结果不确定。操作人是自报标签，不是认证身份；访问密钥控制任务访问，当前限定可信本机。

**为什么不总能自动恢复？** 如果进程在外部调用之后、结果保存之前退出，无法知道调用是否完成。租约到期后，inflight 快照会标记 interrupted，要求新建任务，而不是冒险重复执行。节点间 ready 快照可以恢复；租约未到期则阻止重复启动。批准后的人工等待不消耗模型执行时间，但已用时间和调用预算不会重置。配置指纹变化也会阻止恢复。这不是分布式 exactly-once，当前也没有通用 LangGraph checkpointer 或完整事件重放。

## 9. 研究者、Critic 与 A2A 的关系

`review.ts` 的 `ResearchAgents` 定义两个能力：research 和 critique。默认 `createResearchAgents` 在当前进程用模型实现这两个角色。主图选择 `remote ?? createResearchAgents(...)`，因此角色是节点调用的依赖，并不自动等于独立 LangGraph 节点或独立进程。

启用 A2A 时，`a2a/client.ts` 的 `readAgentEndpoints` 读取地址，`createRemoteAgents` 实现相同接口并通过协议调用独立服务；`a2a/server.ts` 的 `createRoleApp` 提供 Agent Card、任务和执行器，`a2a/main.ts` 启动角色服务，契约在 `a2a/contracts.ts`。主图仍决定何时分析、审查和回环，远程角色不负责主图的检索编排。A2A 是可选边界，不能因为代码有多个角色就认为它们始终跨进程或并行执行。

## 10. 其他三张图是什么

| 文件与入口 | 状态、节点、边在哪里 | 何时用 |
| --- | --- | --- |
| `research/workflow.ts` 的 `runResearch` | `State` 在 7 行；collect_sources、research 在 22 行起；边在 118 行起 | 未启用 Agentic 时的基础流程 |
| `research/agentic.ts` 的 `runAgenticResearch` | `State` 在 37 行；route、acquire、assess、answer 在 141 行起；边在 246 行起 | 启用 Agentic、未启用完整研究循环时；可以决定直接回答、取证或补查 |
| `research/review.ts` 的 `runReviewedResearch` | `State` 在 71 行；research、critic 在 86 行起；边在 152 行起 | 早期 Agentic 多角色审查路径，允许受限修订 |
| `research/loop.ts` 的 `runResearchLoop` | `State` 在 44 行；五节点在 152 行起；边在 389 行起 | M9 完整循环，也是 M10 人工审批所包裹的图 |

它们各自有独立状态和入口，不能把其中同名 research 节点视为同一个节点。具体组合以 `research/routes.ts` 与 `agentic.ts` 的实际调用为准。

## 11. 跟一次具体任务走

假设用户问“项目为什么使用 PostgreSQL？”，且启用 RAG 与人工审批：

1. 页面创建任务；服务记录问题和创建者，然后开始图。
2. planning 选择本地检索，首轮查询由宿主设为原问题；after 保存计划，任务进入 pending。
3. 页面展示问题、子问题、查询与理由；用户可修改查询并批准。
4. 服务从保存的 research 节点继续，用查询取得片段，记录来源编号和取证次数。
5. analyze 让研究者整理资料，再生成带逐字引用的观察/推断；宿主逐一检查引用。
6. critique 检查结论和未解决问题。如果仍缺证，返回 planning；新计划会再次等待批准。若查询重复、没有新证据或预算耗尽，则停止补查。
7. 审查通过后 publish 输出报告；失败或证据不足则不会把未经审查的草稿当成功报告。页面通过轮询读取状态、来源及审计。

这里实际使用哪份资料、模型是否正确复制引文，以及是否能完成，取决于索引内容、配置和模型输出；流程约束不保证每次研究成功。

## 12. 推荐阅读与验证顺序

1. 先看 `index.ts`、`app.ts`、`research/routes.ts`，画出启动和模式选择。
2. 看 `loop.ts` 的 `State`、`graph.invoke` 初始值，再顺着五个 `addNode` 和边阅读。每看一个节点，问自己：读了什么、调用了什么、返回哪些字段、下一站是谁。
3. 深入 `budget.ts`、`review.ts`、`rag/service.ts` 和 `mcp/client.ts`，弄清节点调用的依赖。
4. 再看 `human/routes.ts` → `human/service.ts` → `human/store.ts`，特别比较 `inflight` 和 `ready`、审批和恢复。
5. 最后对照 `apps/api/test/loop.test.ts`、`apps/api/test/human.test.ts` 及其他测试目录中的相应测试，观察正常、缺证、预算、重启和失败分支；前端查看 `HumanResearch.test.tsx` 和 `ResearchForm.test.tsx`。测试可帮助理解预期行为，但不能替代真实模型质量验收。

当修改代码时，同时检查主图边与 `nextNode`、快照版本和配置指纹，以及引用校验与测试；避免只修改一处而让恢复或安全边界与正常运行不一致。
