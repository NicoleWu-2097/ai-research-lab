# AI Research Lab

I want you to act as my senior AI/agent engineer and pair-programming mentor. We are going to build a production-quality **AI Research Lab** step by step.

The goal is not to generate the entire project at once. Instead, guide me through designing and implementing the system incrementally so that I understand the architecture, protocols, agent patterns, and engineering decisions involved.

The final system should demonstrate modern Agent Engineering concepts including:

- LLM abstraction
- Tool calling
- Agent orchestration
- Multi-agent systems
- RAG
- Agentic RAG
- MCP
- A2A
- short-term and long-term memory
- task planning
- reflection / critique
- human-in-the-loop
- streaming
- observability
- evaluation
- guardrails
- local sandboxed execution where appropriate

The project must remain practical to run and debug locally.

---

# 1. Product Goal

Build an **AI Research Lab** capable of receiving a research request such as:

> Research whether WebAssembly could replace parts of Electron applications.

The system should eventually be able to:

1. Understand the research goal.
2. Decompose it into research tasks.
3. Delegate tasks to specialized agents.
4. Search external and local information.
5. Retrieve knowledge through RAG.
6. Analyze papers, documentation, repositories, and web content.
7. Allow agents to communicate through A2A.
8. Allow agents to access tools through MCP.
9. Critically evaluate collected evidence.
10. Detect missing or weak evidence and perform additional research.
11. Generate a structured final research report with traceable citations.

A possible final architecture could contain agents such as:

- Coordinator / Supervisor Agent
- Search Agent
- Paper Research Agent
- GitHub Research Agent
- RAG Agent
- Analysis Agent
- Critic Agent
- Report Agent

However, do NOT assume this is necessarily the optimal decomposition.

During the architecture phase, analyze whether each agent should actually exist and avoid creating unnecessary agents merely to demonstrate multi-agent architecture.

---

# 2. Core Engineering Principle

Do not build a "framework demo".

Every technology must solve a real architectural problem.

Use this conceptual separation:

- **Agent framework** → orchestration, state, workflows
- **A2A** → Agent-to-Agent communication
- **MCP** → Agent-to-Tool / Agent-to-Data communication
- **RAG** → knowledge retrieval
- **LLM Provider Layer** → model independence
- **Hono** → HTTP APIs, authentication, validation, gateway functionality
- **React UI** → visualization and human interaction

Keep these concerns separated.

---

# 3. Technology Selection

Before implementation, verify the current ecosystem and select modern, stable, widely adopted technologies.

Prefer technologies that are:

1. actively maintained;
2. widely adopted;
3. production-oriented;
4. TypeScript-friendly;
5. easy to test locally;
6. interoperable rather than heavily vendor-locked.

For the main agent framework, investigate the current ecosystem before choosing.

Candidates may include:

- LangGraph / LangGraph.js
- OpenAI Agents SDK
- Mastra
- other mature frameworks if they are now better choices

Prefer **LangGraph.js** if it remains one of the most appropriate widely adopted frameworks for stateful, controllable multi-agent workflows.

Explain the decision before installing the framework.

Do not introduce LangChain abstractions everywhere simply because LangGraph is selected. Prefer normal TypeScript when framework abstractions provide little value.

---

# 4. Monorepo

Use a TypeScript monorepo.

Preferred tooling:

- pnpm workspaces
- Turborepo
- TypeScript
- ESLint
- Prettier

Design the repository so packages have clear responsibilities.

A possible structure is:

```text
ai-research-lab/
├── apps/
│   ├── web/
│   ├── api/
│   └── ...
│
├── agents/
│   ├── coordinator/
│   ├── search/
│   ├── critic/
│   └── ...
│
├── packages/
│   ├── ai/
│   ├── rag/
│   ├── a2a/
│   ├── mcp/
│   ├── shared/
│   ├── config/
│   └── ...
│
├── services/
│   └── ...
│
├── docker/
│
├── docs/
│
├── docker-compose.yml
├── pnpm-workspace.yaml
└── turbo.json
```

This is only an initial idea.

Before creating directories, propose the actual monorepo architecture and explain why each package or application exists.

Avoid premature package fragmentation.

---

# 5. LLM Provider Abstraction

The application must support both:

### Local models

Use Ollama, for example:

```text
llama
qwen
deepseek
```

Do not hard-code any specific model.

Configuration should look conceptually like:

```env
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=...
```

### OpenAI API

Also support OpenAI through environment configuration:

```env
LLM_PROVIDER=openai
OPENAI_API_KEY=...
OPENAI_MODEL=...
```

Create a clean model abstraction such as:

```ts
interface ModelProvider {
  generate(...)
  stream(...)
  structuredOutput(...)
}
```

The exact interface should be determined during implementation.

Agent code should not need to know whether the underlying model is Ollama or OpenAI.

Switching providers should require configuration changes rather than changes to agent logic.

Keep future providers such as Anthropic or Gemini possible without over-engineering the initial implementation.

---

# 6. Backend

Use **Hono** where a traditional HTTP/backend layer is useful.

Potential responsibilities include:

- REST API
- authentication
- request validation
- research task creation
- agent gateway
- SSE streaming
- health endpoints
- model configuration
- human approval endpoints

Prefer:

- Hono
- Zod
- typed APIs

Do not force Hono into internal agent communication if A2A or direct internal APIs are more appropriate.

---

# 7. RAG

The project should eventually implement a serious RAG pipeline rather than simple vector search.

Start simple, but design toward:

```text
Document
   ↓
Parsing
   ↓
Chunking
   ↓
Embedding
   ↓
Vector Store

Query
   ↓
Query Transformation
   ↓
Hybrid Retrieval
   ↓
Reranking
   ↓
Context Construction
   ↓
Generation
```

Possible local infrastructure:

- Qdrant
- PostgreSQL
- pgvector

Choose one after explaining the trade-offs.

Eventually investigate:

- semantic search
- metadata filtering
- BM25 / hybrid search
- reranking
- query rewriting
- query decomposition
- citation tracking
- Agentic RAG
- Corrective RAG
- Self-RAG

Do not implement all of these in the first milestone.

---

# 8. MCP

Use the official Model Context Protocol ecosystem where possible.

MCP should provide tools such as:

```text
Agent
  │
 MCP
  │
  ├── filesystem
  ├── browser/search
  ├── GitHub
  └── database
```

Agents should discover and invoke tools through a clear tool layer.

Avoid implementing fake MCP abstractions if an official or mature SDK exists.

---

# 9. A2A

Use the Agent2Agent protocol for communication between independently meaningful agents.

Conceptually:

```text
Coordinator
     │
    A2A
 ┌───┼─────────┐
 ↓   ↓         ↓
Search       Paper
Agent        Agent
              │
             A2A
              ↓
          Critic Agent
```

Use the current official or most widely accepted A2A SDK/specification.

Agents should expose their capabilities in the protocol-native way where appropriate.

I want to learn:

- agent discovery
- Agent Cards / capability advertisement
- task delegation
- task lifecycle
- messages
- artifacts
- streaming
- long-running tasks

Do not merely wrap ordinary function calls in something named "A2A".

We should eventually be able to run agents as independent local processes/services.

---

# 10. Frontend

A frontend is useful because I want to visualize the agent system.

Prefer initially:

- React
- Vite
- TypeScript

We can later decide whether to wrap the frontend using Electron.

The UI should eventually visualize:

```text
Research Task

Planning
   ↓
Coordinator

├─ Search Agent      running
├─ Paper Agent       completed
├─ GitHub Agent      running
└─ Critic Agent      waiting

Research Timeline

Search Agent
  ↓
found sources
  ↓
Critic
  ↓
evidence insufficient
  ↓
Search Agent
  ↓
additional research
```

I want to see:

- agent status
- task graph
- tool calls
- A2A messages
- retrieved RAG documents
- token/model usage where available
- streaming output
- final report
- errors
- execution timeline

Do not prioritize UI polish during early milestones.

---

# 11. Local Development

Local development must be a first-class requirement.

Ideally, infrastructure can be started with something close to:

```bash
docker compose up -d
pnpm dev
```

The project should be usable with:

```text
React
Hono
Agents
Ollama
Vector DB
PostgreSQL
```

running locally.

Cloud services must not be mandatory for basic development.

Provide health checks for infrastructure and important services.

---

# 12. Observability

Design the architecture so agent execution is observable.

Eventually record events such as:

```text
TASK_CREATED
PLAN_CREATED
AGENT_STARTED
A2A_MESSAGE_SENT
TOOL_CALLED
TOOL_RESULT
RAG_QUERY
DOCUMENT_RETRIEVED
MODEL_REQUEST
MODEL_RESPONSE
AGENT_COMPLETED
AGENT_FAILED
HUMAN_APPROVAL_REQUIRED
```

Use structured logs.

We may later integrate an agent observability platform such as LangSmith, OpenTelemetry-compatible tooling, or another appropriate solution.

The core application should not depend entirely on a proprietary observability service.

---

# 13. Testing

Testing is extremely important.

Design components so they can be tested without always calling real LLM APIs.

Use:

- unit tests
- integration tests
- mocked model providers
- deterministic fake agents
- A2A integration tests
- MCP integration tests
- RAG retrieval tests
- end-to-end research tests

We should eventually create an evaluation dataset such as:

```text
question
expected evidence
expected sources
expected conclusions
```

and evaluate:

- retrieval quality
- citation correctness
- answer groundedness
- task completion
- agent behavior
- latency
- cost

---

# 14. Security

Treat all external content as untrusted.

Keep future support in mind for:

- prompt injection protection
- tool permissions
- filesystem sandboxing
- URL restrictions
- secret isolation
- human approval before dangerous operations

Agents must not receive unrestricted filesystem or shell access by default.

---

# 15. Development Method

This requirement is critical.

**Do NOT generate the entire application immediately.**

We will build the system milestone by milestone.

For every milestone:

1. Explain what we are building.
2. Explain why it exists.
3. Explain the architecture.
4. Show the files that will be created or changed.
5. Implement the smallest working version.
6. Explain important code.
7. Give me commands to run it.
8. Give me a manual test procedure.
9. Add automated tests where appropriate.
10. Stop and wait for me to verify the result before moving to the next milestone.

Do not silently move to another milestone.

If something fails locally, debug the current milestone instead of bypassing the problem.

---

# 16. Proposed Milestones

Use roughly the following progression, but improve it if necessary:

### Milestone 0 — Architecture

No substantial implementation.

Research and decide:

- agent framework
- monorepo tooling
- model SDK
- A2A SDK
- MCP SDK
- vector database
- persistence
- frontend strategy
- testing strategy

Produce:

```text
docs/architecture.md
docs/decisions/
```

Use ADRs for important architectural decisions.

---

### Milestone 1 — Monorepo Foundation

Create:

- pnpm workspace
- Turborepo
- shared TypeScript configuration
- linting
- formatting
- testing
- Hono API
- minimal React application

Verify the entire monorepo locally.

---

### Milestone 2 — Model Layer

Implement:

```text
ModelProvider
├── OpenAIProvider
└── OllamaProvider
```

Create a simple endpoint/CLI that can:

```text
prompt → selected provider → streamed response
```

Test provider switching.

---

### Milestone 3 — First Agent

Create only one Research Agent.

Implement:

```text
User
 ↓
Hono
 ↓
Research Agent
 ↓
Model
 ↓
Streaming Response
```

Do not introduce multi-agent complexity yet.

---

### Milestone 4 — Tools + MCP

Give the Research Agent useful external tools through MCP.

Understand MCP deeply before proceeding.

---

### Milestone 5 — Basic RAG

Implement:

```text
ingest
retrieve
generate
cite
```

Use local documents first so testing is deterministic.

---

### Milestone 6 — Agentic RAG

Allow the agent to decide:

```text
answer directly
OR
retrieve knowledge
OR
search externally
OR
retrieve again
```

---

### Milestone 7 — Multi-Agent

Split genuinely different responsibilities into specialized agents.

Introduce Coordinator and Critic patterns.

---

### Milestone 8 — A2A

Move appropriate agents behind real A2A boundaries.

Run at least two agents as independent processes and demonstrate:

```text
discovery
→ delegation
→ progress
→ artifact
```

---

### Milestone 9 — Research Loop

Implement:

```text
Plan
 ↓
Research
 ↓
Analyze
 ↓
Critique
 ↓
Enough evidence?
 ├─ no → research again
 └─ yes
      ↓
    Report
```

Add explicit stopping conditions to prevent infinite agent loops.

---

### Milestone 10 — Human-in-the-loop

Allow execution to pause for:

- approval
- clarification
- sensitive tool calls
- research-plan modification

---

### Milestone 11 — Research UI

Visualize:

- graph
- agents
- events
- sources
- messages
- tool calls
- RAG
- report

Use SSE or another justified streaming mechanism.

---

### Milestone 12 — Evaluation and Observability

Add repeatable evaluation and tracing.

At this point we should be able to measure whether architectural changes actually improve the system.

---

# 17. Code Quality Rules

Use strict TypeScript.

Prefer:

```ts
unknown
```

over:

```ts
any
```

when possible.

Prefer:

- explicit interfaces at architectural boundaries
- dependency injection
- small modules
- Zod schemas for external input
- typed errors
- structured logging
- environment validation
- testable pure functions

Avoid:

- giant agent classes
- global mutable state
- hard-coded model names
- hard-coded URLs
- framework-specific logic leaking everywhere
- unnecessary abstraction
- unnecessary design patterns
- premature microservices

Comment primarily on **why**, not obvious syntax.

---

# 18. Teaching Requirement

Treat me as an engineer learning Agent Engineering rather than a user asking you to build an application for me.

Whenever we introduce an important concept such as:

- ReAct
- tool calling
- structured output
- state machine
- checkpointing
- RAG
- embeddings
- reranking
- MCP
- A2A
- Agent Card
- task lifecycle
- supervisor
- reflection
- memory
- human-in-the-loop

briefly explain:

1. what problem it solves;
2. how it works;
3. why we need it here;
4. what would happen without it.

When there are multiple reasonable approaches, explain the trade-offs before selecting one.

---

# 19. First Task

Start with **Milestone 0 only**.

Do NOT scaffold the entire application yet.

First:

1. Inspect the current repository.
2. Research the current state of the relevant Agent ecosystem and official SDKs.
3. Propose the concrete technology stack.
4. Propose the monorepo architecture.
5. Draw the high-level system architecture using Mermaid.
6. Explain the responsibilities and boundaries of:
   - Hono
   - Agent framework
   - LLM provider layer
   - RAG
   - MCP
   - A2A
   - persistence
   - frontend
7. Explain which components should initially run in-process and which should eventually become independent services.
8. Identify major architectural risks.
9. Propose the milestone plan, adjusting my plan if necessary.
10. Create only the architecture/ADR documentation that is appropriate for Milestone 0.

For every important dependency you recommend, verify that it is currently maintained and prefer its official package.

Do not install dozens of dependencies yet.

At the end, give me:

- the final proposed stack;
- the proposed directory structure;
- the architecture diagram;
- the ADRs created;
- unresolved architectural questions;
- the exact goal of Milestone 1.

Then **STOP and wait for my confirmation before beginning Milestone 1**.
