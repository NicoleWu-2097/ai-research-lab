
# Atlas：通用科研智能体架构诊断与重构任务

你是一名资深 AI Agent 架构师、全栈工程师和科研工具开发工程师。

请直接阅读当前仓库，分析现有架构，定位问题并修改代码。本任务要求完成实际工程实现、测试及必要的文档更新，不能仅给出设计方案。

## 0. 项目背景与最终目标

当前项目 Atlas 是一个结合 RAG 和大模型的科研智能体。

目前已使用或计划使用的技术能力包括：

- Ollama 本地 Embedding
- OpenAI API 作为主要大模型提供方
- 本地知识库与 RAG 检索
- 项目与会话管理
- 网络搜索和科研资料整理
- 报告生成
- 引用和证据验证

请先检查仓库确定真实技术栈、现有能力、具体模型配置和工具实现，不要假设以上功能均已完整实现。

### 核心目标

将 Atlas 改造成一个类似 Codex 的通用任务执行型智能体，并通过可组合工具和专业工作流增强科研能力。

必须具备：

1. 通用自然语言任务理解与执行
2. 自主规划、工具选择、循环执行和错误恢复
3. 项目级上下文管理与跨会话持久化
4. 本地文件读写和工作区管理
5. RAG 检索与知识库管理
6. 网络搜索、网页读取和结果整理
7. 学术论文发现、获取、解析和分析
8. 可追溯的证据、引文和科研报告生成
9. 结构化任务状态、进度反馈和可恢复执行
10. 完善的测试、可观测性和质量评估

最终产品应能够完成编程、文件管理、普通问答、项目分析、科研调研和学术写作等不同类型任务。

**科研工作流必须是增强能力，不能成为所有任务的强制入口。**

## 1. 首先执行仓库级审计

在开始改动之前，全面检查以下内容：

- Monorepo 结构、包依赖、构建与运行方式
- Agent Loop 的具体实现
- System Prompt、Developer Prompt 和工作流 Prompt
- 模型适配层及 API 调用
- Function Calling 和工具注册机制
- 当前工具及其实际执行权限
- RAG 文档索引和检索实现
- 查询重写、Chunking、Embedding 和向量存储
- 引文生成、证据验证、报告审核逻辑
- 项目、会话、消息和任务的持久化设计
- 前端状态同步和工具执行反馈
- 文件保存逻辑
- 最大迭代次数、超时、重试与停止条件

重点搜索可能造成当前行为的代码：

- 强制所有任务进行 RAG 检索
- 强制生成固定结构科研报告
- 强制引用达到固定数量或比例
- 验证失败后立即终止
- 将上一轮研究状态复用到新用户指令
- 将不同项目的知识库或任务状态混用
- 工具返回失败时用文本模拟执行成功
- 将停止原因或错误消息直接拼接进最终报告
- 模型输出 Schema 与解析器预期不一致
- 由于流式输出截断、超时或格式变化导致验证失败

请建立问题清单，对每项说明：

1. 实际代码位置
2. 原有行为
3. 可复现的问题
4. 根因或尚需验证的假设
5. 修改方案
6. 对现有功能的兼容性影响

优先使用日志、Trace、测试和实际工具调用来定位问题。

不要因为某个现象符合猜测，就直接认定其为根因。

## 2. 重构 Agent Runtime

### 2.1 Agent 应以通用执行循环为核心

推荐逻辑：

```text
User Input
    ↓
Understand Request
    ↓
Load Relevant Context
    ↓
Decide Next Action
    ↓
Call Tool / Reason / Delegate
    ↓
Observe Results
    ↓
Update Task State
    ↓
Continue / Replan / Finish
```

请基于现有代码设计通用 Agent Loop。

要求：

- 支持任意合理的自然语言任务
- 模型能够自主判断是否需要调用工具
- 工具调用之后能够获取真实执行结果
- 根据执行结果继续推理
- 可以跨多个工具完成复杂任务
- 支持动态规划和重新规划
- 支持用户中断、取消与后续继续
- 支持工具执行失败后的合理恢复
- 对复杂任务支持检查点与持久化
- 对简单任务可以直接输出答案

不要将固定的 Planning → RAG → Report → Validation 流程作为默认 Agent Loop。

### 2.2 设计明确的任务状态机

至少区分：

```text
created
running
waiting_for_tool
waiting_for_user
recovering
completed
partially_completed
failed
cancelled
```

另外使用独立字段表示：

- 当前执行步骤
- 已完成工作
- 未完成工作
- 阻塞原因
- 失败类型
- 证据充分程度
- 是否需要用户确认
- 最后一次有效输出
- 资源使用情况

不要把“证据不足”直接等同于任务失败。

不要将“报告校验通过”作为所有任务的完成条件。

### 2.3 任务完成条件

必须基于用户意图判断成功。

例如：

- 普通问答：生成针对当前问题的有效答案
- 文件写入：文件实际写入成功并可验证
- 代码修改：真实代码变更，必要测试通过
- 文献检索：返回有效文献结果与可追溯来源
- 科研综述：完成合理范围内的研究、归纳与证据关联
- 分析任务：输出针对目标对象的可执行分析

可以采用不同任务类型对应不同验证策略。

验证器应协助 Agent 确认任务成果，而不是独占任务控制权。

### 2.4 自恢复机制

为错误设置分类：

```text
tool_error
network_error
model_error
schema_error
retrieval_error
evidence_error
permission_error
budget_exceeded
unrecoverable_error
```

恢复策略：

- 网络超时：有限次数重试与退避
- 检索无结果：查询改写、调整范围、切换检索源
- 证据不足：补充检索或降低结论强度
- Schema 解析错误：使用验证错误反馈进行局部修复
- 工具不可用：选择可用的替代工具
- 上下文接近限制：执行压缩并保留任务关键状态
- 任务不可完成：保留已有成果并说明具体阻塞原因

必须设置合理的步骤、时间、Token 和成本预算，防止无限循环。

禁止反复执行没有新增信息的重试。

## 3. 修复上下文污染和项目隔离

当前存在一个重要异常：

用户首先研究红色花卉的生物学问题，随后切换到另一个项目，提出：

“Atlas 有哪些可以在 UX 方面改进的点？”

Agent 却继续输出红色花卉的研究报告。

请定位此问题。

### 3.1 区分以下状态

- Conversation History：对话历史
- Active User Request：当前用户请求
- Task State：当前任务状态
- Project Context：当前项目上下文
- Project Knowledge Base：项目知识库
- Retrieved Context：本次任务检索内容
- Agent Working Memory：当前任务的临时工作记忆
- Artifact State：任务创建的成果文件

不同层级使用稳定 ID 关联。

每次新用户消息都必须明确确定当前请求的任务归属。

切换项目时，不得继续使用另一项目的检索片段、任务计划或未完成草稿，除非用户明确要求跨项目引用。

### 3.2 支持连续任务

不要简单地在每次消息后清空状态。

以下指令应能正确理解：

- “继续刚才的调研”
- “把刚才的报告保存成 Markdown”
- “只修改报告中的结论部分”
- “切换项目”
- “重新检索，不要复用之前的结果”

针对指代模糊的情况，使用对话历史确定指代对象。

新问题与之前任务明显无关时，应创建新任务上下文。

项目切换后的第一条任务必须进行上下文隔离测试。

## 4. 将 RAG 改造为可选择工具

RAG 是 Agent 的一种工具，不应成为所有任务的必经流程。

### 4.1 提供统一检索接口

根据实际项目架构设计类似以下工具：

```ts
searchKnowledgeBase({
  query,
  projectId,
  documentIds,
  filters,
  topK
})
```

保留现有 Ollama 本地 Embedding 配置。

不要未经理由就更换现有模型提供方或删除本地能力。

### 4.2 优化检索流程

检查并视需要实现：

1. Query Rewriting
2. 多查询检索
3. Dense Vector Search
4. BM25 / Sparse Search
5. Hybrid Retrieval
6. Reciprocal Rank Fusion
7. Reranking
8. Metadata Filtering
9. Parent-Child Chunk Retrieval
10. Context Deduplication

这些能力应以可配置模块组合，避免一次性引入大量不必要的依赖。

对中文、英文和跨语言检索进行测试。

### 4.3 文档索引设计

每个 Chunk 至少考虑保存：

```ts
interface KnowledgeChunk {
  id: string;
  projectId: string;
  documentId: string;
  text: string;
  metadata: {
    source: string;
    title?: string;
    section?: string;
    page?: number;
    startOffset?: number;
    endOffset?: number;
  };
  embeddingModel: string;
  embeddingVersion?: string;
}
```

具体 Schema 应与现有数据库兼容。

要求：

- 支持来源追踪
- 支持重新索引
- 支持文档更新与删除
- 支持不同项目隔离
- 记录索引版本
- 避免模型变更导致向量维度或检索结果错误
- 保留原始文档及可追溯的解析结果

### 4.4 RAG 结果必须经过相关性判断

如果用户提出 UX 改进问题，而当前 RAG 只返回植物学文献：

Agent 应忽略这些不相关片段，并使用适当的其他工具或现有项目上下文完成任务。

禁止为了满足引文数量而引用无关内容。

RAG 返回空结果时，不能直接推断为整个任务失败。

## 5. 设计科研工具与工作流

科研能力通过 Skills、Tools 或可选 Workflow 扩展通用 Agent。

优先复用仓库现有接口。

### 5.1 文献发现

根据可用性接入以下来源：

- OpenAlex
- Crossref
- Semantic Scholar
- arXiv
- 普通 Web Search

要求：

- 可根据主题、关键词、作者、年份检索
- 支持多关键词与查询扩展
- 支持 DOI、标题或其他稳定标识去重
- 获取可用的摘要与元数据
- 区分预印本、同行评审论文和其他出版物
- 返回来源链接与检索时间
- 遵守 API 限额和访问权限

实现必要的缓存、限流与错误恢复。

如需新增凭证，使用环境变量和配置文件，不要硬编码。

### 5.2 论文读取与整理

支持在合法访问条件下：

- 获取 PDF 或网页全文
- 读取摘要
- 抽取章节结构
- 提取标题、作者、年份、DOI
- 解析表格、公式和图注
- 将内容转换为适合检索的结构化表示
- 保存原文与转换后的内容
- 添加到当前项目知识库
- 导出文献总结和 Markdown 笔记

不要假设 PDF 转 Markdown 一定能够完整保留信息。

特别检查双栏 PDF、公式、图表、脚注、参考文献和跨页表格。

对解析失败或信息丢失的部分保留原 PDF 定位。

### 5.3 科研工作流

提供可选择的工作流能力，例如：

```text
Literature Discovery
Literature Review
Paper Comparison
Research Gap Analysis
Evidence Synthesis
Academic Writing
Citation Verification
Research Note Generation
```

用户提出相关任务时，Agent 可以动态选择这些能力。

例如：

“研究近三年 Agentic RAG 的发展”

Agent 可以：

1. 规划研究子问题
2. 搜索论文
3. 去重并获取元数据
4. 阅读相关摘要或全文
5. 整理方法与研究方向
6. 对比不同论文
7. 汇总结论
8. 验证关键引文
9. 输出报告并保存文件

不应要求每个科研任务都执行全部步骤。

### 5.4 避免过度多智能体化

默认使用一个通用主 Agent。

只有在任务足够复杂且确实有收益时，才考虑将独立研究、并行文献搜索、专项验证等任务委托给子 Agent。

先保证单 Agent Loop 可靠，再按需求引入 Multi-Agent。

不要为了架构复杂度而创建多个 Agent。

## 6. 重构证据与引用系统

这是本次改造的重点。

### 6.1 建立统一 Evidence Store

每条 Evidence 应至少具有：

```ts
interface Evidence {
  id: string;
  taskId: string;
  sourceId: string;
  sourceType: "rag" | "web" | "paper" | "file";
  documentId?: string;
  chunkId?: string;
  url?: string;
  doi?: string;
  title?: string;
  originalText: string;
  locator?: {
    page?: number;
    section?: string;
    startOffset?: number;
    endOffset?: number;
  };
  retrievedAt: string;
}
```

以上是参考结构，请结合已有数据模型实现。

引文必须关联真实 Evidence ID。

严禁模型凭空编造 Evidence ID、DOI、页码或原文。

### 6.2 Claim 与 Evidence 分离

在科研任务中建立明确关系：

```text
Claim
  ↓
Supporting / Contradicting / Insufficient Evidence
  ↓
Source
  ↓
Original Document Location
```

验证时应判断：

- 原始来源是否真实存在
- 引文能否定位到实际内容
- 引用与 Claim 是否相关
- 原文是否真正支持 Claim
- 是否存在冲突证据
- 是否把推论错误表述成确定事实

不能仅根据引用数量或文本相似度认定证据充分。

### 6.3 引用验证的返回结构

设计类似：

```ts
interface VerificationResult {
  status: "pass" | "partial" | "fail";
  issues: Array<{
    claimId?: string;
    evidenceId?: string;
    type: string;
    message: string;
    recoverable: boolean;
    suggestedAction?: string;
  }>;
}
```

验证失败必须定位到具体 Claim 或 Citation。

支持局部修复。

例如：

- 某条引用失效：重新查找或删除该引用
- 某条结论缺少证据：尝试补充检索
- 原文只支持弱结论：修改断言强度
- 论文只有摘要：明确说明证据来自摘要
- 文献之间存在冲突：同时呈现不同结果

不要因为一条引用不合格就丢弃整份报告。

### 6.4 使用分级验证策略

至少提供：

**General**

用于普通对话、代码解释、文件管理、项目分析。

不强制引文验证。

**Research**

用于一般科研问答和探索性调研。

要求重要结论能够追溯来源，允许对不确定内容作明确标注。

**Strict Research**

用于正式研究报告、论文综述、学术写作等。

要求更严格的 Claim-Evidence 对应、引文校验和事实核查。

模式应根据用户意图合理选择，同时允许显式配置。

不要依赖关键词匹配作为唯一判断依据。

## 7. 实现真实文件和项目操作

用户要求：

“把报告写入 md 文档保存到当前目录”

Agent 必须实际调用文件写入工具。

需要检查并完善：

```text
read_file
write_file
edit_file
list_directory
search_files
create_directory
```

工具名称可沿用仓库现有命名。

如项目需要 Codex 类编程能力，可提供受控的命令执行和代码测试工具。

要求：

- 明确工作目录和项目根目录
- 使用统一路径解析
- 防止非法路径穿越
- 按权限限制文件读写
- 写入成功后校验实际文件
- 返回真实文件路径
- 支持覆盖前确认或安全备份
- 支持必要的 diff 和修改记录
- 高风险操作需要用户授权

禁止仅返回 Markdown 代码块就宣称文件保存成功。

工具失败必须将真实错误传回 Agent。

## 8. 改善上下文与长期任务管理

实现合理的上下文策略：

### 8.1 Short-Term Context

保留：

- 当前用户目标
- 最近有效的对话
- 当前计划
- 工具调用结果
- 任务进度

### 8.2 Project Memory

保留：

- 项目简介
- 项目目录
- 已索引资料
- 用户显式确定的约束
- 相关研究成果
- 重要的项目状态

### 8.3 Task Memory

保留：

- 任务目标
- 完成步骤
- 未完成步骤
- 失败记录
- 已验证 Evidence
- 中间成果
- 可恢复检查点

### 8.4 Context Compaction

在接近上下文限制时，压缩过长历史。

需要保留：

- 用户原始目标
- 当前项目身份
- 重要约束
- 文件与 Evidence ID
- 尚未完成的工作
- 必要的工具执行结果

不要将大段原始 PDF、网页结果或全部 RAG Chunk 无限制追加到主 Agent 上下文中。

应尽量通过工具按需读取。

## 9. 统一工具注册和执行反馈

建立统一工具契约。

每个工具应声明：

- 名称和用途
- 输入 Schema
- 输出 Schema
- 所需权限
- 超时设置
- 错误类型
- 可否重试
- 是否存在副作用
- 是否支持取消

建议将工具执行结果标准化为：

```ts
type ToolResult<T> =
  | {
      success: true;
      data: T;
      metadata?: Record<string, unknown>;
    }
  | {
      success: false;
      error: {
        code: string;
        message: string;
        retryable: boolean;
      };
    };
```

针对文件写入、网络访问、下载、Shell 等操作设计不同权限策略。

避免模型将失败的工具调用误判为成功。

## 10. 前端和 CLI 用户体验

请检查项目当前已有的交互方式，并做必要改造。

### 10.1 清晰展示任务执行过程

支持可观察的事件：

```text
task_started
plan_updated
tool_started
tool_completed
tool_failed
evidence_added
verification_completed
artifact_created
task_completed
task_failed
```

前端可以按时间顺序展示：

- 当前任务
- Agent 正在执行的步骤
- 工具调用情况
- 检索结果
- 当前发现
- 实际生成的文件
- 失败原因和下一步操作

### 10.2 正确处理流式输出

如果当前使用 SSE、WebSocket 或其他流式机制：

- 保留现有可用实现
- 检查事件协议是否一致
- 区分中间过程和最终回答
- 确保工具结果不会被误当成最终文本
- 避免重复消息或报告重复渲染
- 支持断连和必要的任务状态恢复

### 10.3 最终报告展示

用户只需要看到整理后的任务成果。

不要把内部验证器日志、重复草稿、历史任务报告直接拼接在最终答案里。

允许提供单独的调试视图和执行记录。

## 11. 必须实现的回归测试

请基于当前仓库测试框架新增真实测试。

### Case A：任务切换与上下文隔离

过程：

1. 创建项目 A
2. 导入植物学文档
3. 提问“为什么花是红色的？”
4. 创建并切换到项目 B
5. 提问“Atlas 有哪些 UX 改进点？”

预期：

- 项目 B 的回答围绕 Atlas UX
- 不继承项目 A 的研究计划
- 不引用无关植物学资料
- 不输出红色花卉的报告
- 能根据可访问的项目代码、文档或用户信息给出 UX 建议

### Case B：引文校验失败后的恢复

过程：

1. 发起需要证据的科研调研
2. 模拟某条 Evidence 无法支持对应 Claim
3. 触发验证器

预期：

- 正确定位不合格的 Claim
- 选择合理修复策略
- 必要时补充检索
- 无法补充时调整结论或标记限制
- 保留有效的研究成果
- 不无限重试
- 不因为单条证据失败而直接终止整个任务

### Case C：实际文件保存

过程：

1. 生成 Markdown 报告
2. 输入“把报告保存到当前目录”

预期：

- 调用真实文件工具
- 生成实际 Markdown 文件
- 文件内容符合当前报告
- 写入后可以读回
- 最终回答给出有效路径
- 工具失败时不能声称保存成功

### Case D：普通对话不强制 RAG

输入：

“解释什么是 React Fiber”

预期：

- 可以直接回答
- 不强制生成科研报告
- 不强制包含 RAG 引用
- 不触发无关论文检索

### Case E：RAG 检索无结果

输入：

用户询问当前知识库未覆盖的一个合理问题。

预期：

- 正确识别没有相关本地证据
- 根据任务意图和可用工具决定是否使用网络搜索
- 允许基于一般知识回答并标注不确定性
- 不能输出虚构的 RAG 引用

### Case F：跨轮任务连续性

过程：

1. 用户生成报告
2. 用户要求修改其中一节
3. 用户要求保存
4. 用户要求继续补充引用

预期：

- 正确维护同一个工作成果
- 修改发生在正确对象上
- 不丢失已有有效内容
- 不出现重复报告堆叠

### Case G：模型和工具故障注入

模拟：

- OpenAI API 超时
- Ollama Embedding 不可用
- 网络搜索返回空结果
- 文件工具权限不足
- 模型生成的结构化输出不合法

预期：

- 正确分类错误
- 可恢复错误执行有界恢复
- 不可恢复错误给出清晰状态
- 不伪造工具结果
- 保留任务已完成成果

## 12. 可观测性和评估

为每次任务生成 Trace ID。

至少记录：

- Task ID / Project ID / Session ID
- Agent Loop 迭代次数
- 模型调用与 Token 使用量
- 工具调用结果与延迟
- 检索查询和命中结果
- Rerank 结果
- Evidence 验证状态
- 失败类型与恢复动作
- 实际创建或修改的 Artifact

日志应支持定位生产环境问题，但应避免泄露 API Key、密钥和敏感用户内容。

建立基础评估集，覆盖：

- 通用任务成功率
- 工具调用正确率
- 任务切换正确率
- 文件操作成功率
- RAG 检索相关性
- Evidence Groundedness
- 引用可追溯率
- 任务恢复成功率
- 科研报告质量
- 平均延迟和 Token 成本

为检索策略、Reranking、验证模式和恢复策略预留配置开关，以便后续开展消融实验。

不能只用模型对模型输出的主观评分作为唯一质量标准。

## 13. 技术栈与实现约束

1. 优先沿用现有技术栈和 Monorepo 结构。
2. 保留 Ollama 本地 Embedding 与 OpenAI API。
3. 如需修改 Agent 框架，先对比现有实现与候选方案的适配性。
4. 可以研究 OpenAI Agents SDK、LangGraph 或现有自定义 Runtime，但不要未经论证直接迁移。
5. 避免过度工程化和不必要的抽象。
6. 所有新增工具必须可以在本地测试。
7. 核心模块应具有清晰接口，方便后续新增 MCP、CLI、Web 工具与科研 Skills。
8. 数据库 Schema 变更需要迁移策略。
9. 不得破坏现有项目、会话和知识库数据。
10. 保留原有可用功能和配置兼容性。
11. 修改后需要通过类型检查、构建和相关测试。
12. 对外部服务不可用的测试使用 Mock 或 Fixture，并明确区分模拟测试与真实集成测试。
13. 不要声称未经运行的测试已经通过。

## 14. 实施优先级

请分阶段实施。

### P0：修复当前核心故障

优先实现：

- 定位并修复任务切换污染
- 修复报告验证失败的异常终止
- 修复 RAG 强制引用或无关召回问题
- 修复文件写入工具
- 修复任务成功条件
- 增加关键回归测试

### P1：完善通用 Agent 能力

实现：

- 稳定 Agent Loop
- 通用工具系统
- 错误恢复
- 任务状态持久化
- 上下文压缩
- 可观测性

### P2：增强 RAG 和科研功能

实现：

- 混合检索与 Rerank
- Evidence Store
- 文献元数据检索
- PDF 解析与结构化整理
- 科研工作流
- 多来源证据整合

### P3：体验和质量优化

实现：

- 前端执行状态展示
- 报告和 Artifact 管理
- 评估与消融实验接口
- 性能优化
- 更完善的开发文档

阶段之间应保持可运行、可测试。

如果现有框架已经具备某项能力，应复用、修复或增强，不要重复实现。

## 15. 最终交付要求

请在仓库中完成实际代码修改，并输出：

1. 当前架构与根因分析
2. 实际修改的文件和关键实现
3. Agent Runtime 与工具架构说明
4. RAG 和 Evidence 系统改造说明
5. 测试结果及未通过的测试
6. 必要的配置与数据库迁移步骤
7. 剩余技术债务与风险
8. 后续可扩展能力及消融实验接口

在项目适当的 docs 目录中维护架构文档和测试说明。

如果某项功能暂时无法实现，应保留清晰的接口与限制说明，不要伪造完成状态。

## 16. 最重要的设计原则

**Atlas 的核心定位是：具备科研能力的通用智能体。**

请始终遵守以下原则：

- User Goal First
- General Agent First
- Tools as Capabilities
- Research as Optional Workflow
- Evidence as Traceable Data
- Validation as Recoverable Feedback
- Artifacts as Real Files
- Project Isolation by Default
- Observable and Resumable Execution

最终希望 Atlas 表现为：

用户提出目标 → Agent 判断如何完成 → 自主调用合适工具 → 根据结果调整行为 → 完成真实任务 → 返回可验证的成果。

请立即从仓库审计开始，并在确认根因后按 P0 → P1 → P2 → P3 的优先级实施。不要停留在分析和方案描述阶段。
