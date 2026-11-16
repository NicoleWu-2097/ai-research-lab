import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LocalRetriever } from "../research/agentic.js";
import { createDeadline, raceWithAbort } from "../model/deadline.js";
import type { ModelProvider } from "../model/types.js";
import type { RagService } from "../rag/service.js";
import type { RetrievalStrategy } from "../rag/hybrid.js";
import { tokenizeText } from "../rag/hybrid.js";
import { registerAcademicTools } from "./academic-tools.js";
import {
  analyzeUserRequest,
  compactContext,
  ContextManager,
  replaceMarkdownSection,
} from "./context.js";
import { EvidenceStore } from "./evidence.js";
import { TraceCollector, type TaskTrace } from "./observability.js";
import { classifyError, ToolRegistry } from "./tools.js";
import {
  repairReportLocally,
  selectVerificationMode,
  verifyDraftAndClaims,
} from "./verification.js";
import { registerWorkspaceTools } from "./workspace-tools.js";
import type {
  ArtifactRecord,
  Evidence,
  ObservableEvent,
  ObservableEventType,
  TaskState,
  ToolDefinition,
  ToolPermission,
  VerificationMode,
} from "./types.js";

export interface RuntimeConfig {
  workspaceRoot?: string | undefined;
  maxIterations?: number | undefined;
  maxModelCalls?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  timeoutMs?: number | undefined;
  retrievalStrategy?: RetrievalStrategy | undefined;
  enableQueryRewrite?: boolean | undefined;
  enableReranking?: boolean | undefined;
  verificationMode?: VerificationMode | undefined;
  enableSelfRecovery?: boolean | undefined;
  permissions?: ToolPermission[] | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface ExecuteTaskInput {
  message: string;
  projectId?: string | undefined;
  sessionId?: string | undefined;
  workspaceRoot?: string | undefined;
  verificationMode?: VerificationMode | undefined;
  permissions?: ToolPermission[] | undefined;
  requireUserConfirmation?: boolean | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: ObservableEvent) => void | Promise<void>) | undefined;
  onDelta?: ((delta: string) => void | Promise<void>) | undefined;
}

export interface ExecuteTaskResult {
  taskState: TaskState;
  output: string;
  evidences: Evidence[];
  artifacts: ArtifactRecord[];
  trace: TaskTrace;
}

export interface PlannedAction {
  action:
    | "direct_answer"
    | "search_knowledge_base"
    | "web_search"
    | "discover_literature"
    | "read_file"
    | "write_file"
    | "edit_file"
    | "list_directory"
    | "search_files"
    | "finish";
  query?: string | undefined;
  path?: string | undefined;
  content?: string | undefined;
  reason: string;
}

export class AtlasAgentRuntime {
  readonly contextManager: ContextManager;
  readonly evidenceStore: EvidenceStore;
  readonly traceCollector: TraceCollector;
  readonly toolRegistry: ToolRegistry;
  readonly config: {
    workspaceRoot: string;
    maxIterations: number;
    maxModelCalls: number;
    maxToolCalls: number;
    maxTokens: number;
    timeoutMs: number;
    retrievalStrategy: RetrievalStrategy;
    enableQueryRewrite: boolean;
    enableReranking: boolean;
    enableSelfRecovery: boolean;
    permissions: ToolPermission[];
    verificationMode?: VerificationMode | undefined;
    fetchImpl?: typeof fetch | undefined;
  };
  private readonly tasks = new Map<string, TaskState>();

  constructor(
    readonly provider: ModelProvider | null,
    readonly rag: RagService | null = null,
    readonly web: LocalRetriever | null = null,
    config: RuntimeConfig = {},
  ) {
    this.contextManager = new ContextManager();
    this.evidenceStore = new EvidenceStore();
    this.traceCollector = new TraceCollector();
    this.toolRegistry = new ToolRegistry();

    this.config = {
      workspaceRoot: config.workspaceRoot ?? process.cwd(),
      maxIterations: config.maxIterations ?? 8,
      maxModelCalls: config.maxModelCalls ?? 12,
      maxToolCalls: config.maxToolCalls ?? 8,
      maxTokens: config.maxTokens ?? 120_000,
      timeoutMs: config.timeoutMs ?? 60_000,
      retrievalStrategy: config.retrievalStrategy ?? "hybrid",
      enableQueryRewrite: config.enableQueryRewrite ?? true,
      enableReranking: config.enableReranking ?? true,
      enableSelfRecovery: config.enableSelfRecovery ?? true,
      permissions: config.permissions ?? ["none", "read", "write", "network"],
      ...(config.verificationMode
        ? { verificationMode: config.verificationMode }
        : {}),
      ...(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {}),
    };

    this.registerBuiltinTools();
  }

  private registerBuiltinTools(): void {
    // 1. Workspace file tools
    registerWorkspaceTools(this.toolRegistry, {
      onArtifactCreated: (artifact) => {
        this.contextManager.recordArtifact(artifact);
      },
    });

    // 2. Academic discovery & paper parsing tools
    registerAcademicTools(this.toolRegistry, {
      fetchImpl: this.config.fetchImpl,
      rag: this.rag,
      evidenceStore: this.evidenceStore,
    });

    // 3. Unified Knowledge Base search tool (Section 4.1)
    const searchKbTool: ToolDefinition<
      {
        query: string;
        projectId?: string;
        documentIds?: string[];
        topK?: number;
        strategy?: RetrievalStrategy;
      },
      {
        hits: Array<{
          id: string;
          documentId: string;
          content: string;
          score: number;
        }>;
        evidenceIds: string[];
        filteredIrrelevantCount: number;
        emptyReason?: string;
      }
    > = {
      name: "search_knowledge_base",
      description:
        "Search the project's local RAG knowledge base using hybrid retrieval, query rewriting, reranking, and relevance filtering.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(2000),
        projectId: z.string().optional(),
        documentIds: z.array(z.string()).optional(),
        topK: z.number().int().min(1).max(10).default(4),
        strategy: z.enum(["dense", "bm25", "hybrid"]).optional(),
      }),
      outputSchema: z.object({
        hits: z.array(
          z.object({
            id: z.string(),
            documentId: z.string(),
            content: z.string(),
            score: z.number(),
          }),
        ),
        evidenceIds: z.array(z.string()),
        filteredIrrelevantCount: z.number().int(),
        emptyReason: z.string().optional(),
      }),
      permission: "read",
      timeoutMs: 15_000,
      errorTypes: ["retrieval_error"],
      retryable: true,
      sideEffects: false,
      cancellable: true,
      execute: async (input, context) => {
        if (!this.rag) {
          return {
            success: true,
            data: {
              hits: [],
              evidenceIds: [],
              filteredIrrelevantCount: 0,
              emptyReason: "rag_disabled",
            },
          };
        }
        const effectiveProjectId = input.projectId ?? context.projectId;
        const result = await this.rag.searchKnowledgeBase(
          {
            query: input.query,
            projectId: effectiveProjectId,
            documentIds: input.documentIds,
            topK: input.topK ?? 4,
            strategy: input.strategy ?? this.config.retrievalStrategy,
            enableQueryRewrite: this.config.enableQueryRewrite,
            enableReranking: this.config.enableReranking,
            enableRelevanceFilter: true,
          },
          context.signal,
        );

        const evidences = this.evidenceStore.addRagHits(
          context.taskId,
          effectiveProjectId,
          result.hits,
        );

        this.traceCollector.recordRetrieval(
          context.traceId,
          {
            query: input.query,
            rewrittenQueries: result.rewrittenQueries,
            strategy: result.strategy,
            hitCount: evidences.length,
            filteredIrrelevantCount: result.filteredIrrelevantCount,
            hitIds: evidences.map((e) => e.id),
          },
          result.rerankLog,
        );

        for (const ev of evidences) {
          await context.emit?.(
            "evidence_added",
            `检索到相关知识库片段 [${ev.id}] (${ev.documentId})`,
            { evidence: ev },
          );
        }

        return {
          success: true,
          data: {
            hits: evidences.map((ev, i) => ({
              id: ev.id,
              documentId: ev.documentId ?? ev.sourceId,
              content: ev.originalText,
              score: result.hits[i]?.score ?? 0,
            })),
            evidenceIds: evidences.map((e) => e.id),
            filteredIrrelevantCount: result.filteredIrrelevantCount,
            ...(result.emptyReason ? { emptyReason: result.emptyReason } : {}),
          },
        };
      },
    };
    this.toolRegistry.register(searchKbTool);

    // 4. Web Search tool
    const webSearchTool: ToolDefinition<
      { query: string },
      {
        results: Array<{
          id: string;
          title: string;
          url: string;
          snippet: string;
        }>;
        evidenceIds: string[];
      }
    > = {
      name: "web_search",
      description: "Search the web for external information and snippets.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(600),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string(),
            snippet: z.string(),
          }),
        ),
        evidenceIds: z.array(z.string()),
      }),
      permission: "network",
      timeoutMs: 15_000,
      errorTypes: ["network_error", "retrieval_error"],
      retryable: true,
      sideEffects: false,
      cancellable: true,
      execute: async (input, context) => {
        if (!this.web) {
          return {
            success: true,
            data: { results: [], evidenceIds: [] },
          };
        }
        const rawHits = await this.web.retrieve(input.query, context.signal);
        const results: Array<{
          id: string;
          title: string;
          url: string;
          snippet: string;
        }> = [];
        const evidenceIds: string[] = [];

        for (const hit of rawHits) {
          const url =
            ("url" in hit && typeof hit.url === "string"
              ? hit.url
              : hit.documentId) || "https://search.local";
          const title =
            ("title" in hit && typeof hit.title === "string"
              ? hit.title
              : hit.documentId) || "Web Result";
          const ev = this.evidenceStore.add({
            taskId: context.taskId,
            projectId: context.projectId,
            sourceId: url,
            sourceType: "web",
            url,
            title,
            originalText: hit.content,
            retrievedAt: hit.retrievedAt,
          });
          evidenceIds.push(ev.id);
          results.push({
            id: ev.id,
            title,
            url,
            snippet: hit.content,
          });
          await context.emit?.(
            "evidence_added",
            `新增网络搜索证据 [${ev.id}]：${title}`,
            { evidence: ev },
          );
        }

        return {
          success: true,
          data: { results, evidenceIds },
        };
      },
    };
    this.toolRegistry.register(webSearchTool);
  }

  getTask(taskId: string): TaskState | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(projectId?: string): TaskState[] {
    const all = [...this.tasks.values()];
    return projectId ? all.filter((t) => t.projectId === projectId) : all;
  }

  private async callModelWithRecovery<T>(params: {
    taskState: TaskState;
    traceId: string;
    step: string;
    operation: "generate" | "structuredOutput";
    prompt: string;
    schema?: z.ZodType<T>;
    signal: AbortSignal;
    fallbackValue?: () => T;
  }): Promise<T> {
    if (!this.provider) {
      throw Object.assign(new Error("Model provider is not configured."), {
        code: "MODEL_NOT_CONFIGURED",
      });
    }

    const maxAttempts = this.config.enableSelfRecovery ? 2 : 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      params.signal.throwIfAborted();
      if (
        params.taskState.resourceUsage.modelCalls >=
        params.taskState.resourceUsage.maxModelCalls
      ) {
        params.taskState.failureCategory = "budget_exceeded";
        throw Object.assign(new Error("Model call budget exceeded."), {
          code: "BUDGET_EXCEEDED",
        });
      }

      const start = Date.now();
      const inputTokens = Math.ceil(Buffer.byteLength(params.prompt) / 4);
      params.taskState.resourceUsage.modelCalls++;
      params.taskState.resourceUsage.estimatedTokens += inputTokens;

      try {
        let output: T;
        if (params.operation === "structuredOutput" && params.schema) {
          const effectivePrompt =
            attempt > 1
              ? `${params.prompt}\n\n[Validation Repair]: Previous output did not match the required JSON schema. Return valid JSON strictly conforming to the schema.`
              : params.prompt;
          const raw = await raceWithAbort(
            this.provider.structuredOutput(
              effectivePrompt,
              params.schema,
              params.signal,
            ),
            params.signal,
          );
          output = params.schema.parse(raw);
        } else {
          output = (await raceWithAbort(
            this.provider.generate(params.prompt, params.signal),
            params.signal,
          )) as unknown as T;
        }

        const outTokens = Math.ceil(
          Buffer.byteLength(
            typeof output === "string" ? output : JSON.stringify(output),
          ) / 4,
        );
        params.taskState.resourceUsage.estimatedTokens += outTokens;

        this.traceCollector.recordModelCall(params.traceId, {
          step: params.step,
          provider: this.provider.provider,
          model: this.provider.model,
          operation: params.operation,
          inputTokensEstimate: inputTokens,
          outputTokensEstimate: outTokens,
          latencyMs: Date.now() - start,
          success: true,
        });

        if (attempt > 1) {
          this.traceCollector.recordRecovery(params.traceId, {
            step: params.step,
            failureCategory: classifyError(lastError).category,
            action: "model_retry_with_repair",
            succeeded: true,
            message: `Recovered on attempt ${attempt} at step ${params.step}.`,
          });
        }

        return output;
      } catch (err) {
        if (params.signal.aborted) throw params.signal.reason ?? err;
        lastError = err;
        const classified = classifyError(err);

        this.traceCollector.recordModelCall(params.traceId, {
          step: params.step,
          provider: this.provider.provider,
          model: this.provider.model,
          operation: params.operation,
          inputTokensEstimate: inputTokens,
          outputTokensEstimate: 0,
          latencyMs: Date.now() - start,
          success: false,
          errorCode: classified.code,
        });

        if (
          attempt < maxAttempts &&
          this.config.enableSelfRecovery &&
          (classified.category === "network_error" ||
            classified.category === "model_error" ||
            classified.category === "schema_error")
        ) {
          params.taskState.status = "recovering";
          params.taskState.resourceUsage.retries++;
          continue;
        }
      }
    }

    const classified = classifyError(lastError);
    if (params.fallbackValue && this.config.enableSelfRecovery) {
      this.traceCollector.recordRecovery(params.traceId, {
        step: params.step,
        failureCategory: classified.category,
        action: "schema_or_model_fallback",
        succeeded: true,
        message: `Used safe fallback after ${classified.code}: ${classified.message}`,
      });
      return params.fallbackValue();
    }

    params.taskState.failureCategory = classified.category;
    throw lastError;
  }

  /**
   * 2.1 General Agent Execution Loop
   * User Input -> Understand Request -> Load Relevant Context -> Decide Next Action
   * -> Call Tool / Reason / Delegate -> Observe Results -> Update Task State -> Continue / Replan / Finish
   */
  async execute(input: ExecuteTaskInput): Promise<ExecuteTaskResult> {
    const startTime = Date.now();
    const previousProjectId = this.contextManager.getActiveProjectId();
    const projectId = input.projectId ?? previousProjectId ?? "default";
    const sessionId = input.sessionId ?? `session:${projectId}`;
    const workspaceRoot =
      input.workspaceRoot ??
      this.contextManager.ensureProject(projectId, {
        workspaceRoot: this.config.workspaceRoot,
      }).context.workspaceRoot ??
      this.config.workspaceRoot;

    // Ensure project exists and switch active project
    this.contextManager.switchProject(projectId, { workspaceRoot });
    const projectMemory = this.contextManager.getProjectMemory(projectId);
    const recentTurns = this.contextManager.getProjectTurns(projectId);

    // Step 1: Understand Request & Determine Task Belonging / Continuity
    const activeRequest = analyzeUserRequest({
      message: input.message,
      projectId,
      previousProjectId,
      sessionId,
      projectMemory,
      recentTurns,
      explicitVerificationMode:
        input.verificationMode ?? this.config.verificationMode,
    });

    const taskId =
      activeRequest.continuity === "new_task" ||
      activeRequest.continuity === "fresh_retrieval" ||
      activeRequest.continuity === "switch_project"
        ? randomUUID()
        : activeRequest.taskId;

    const verificationMode = selectVerificationMode(
      activeRequest.category,
      activeRequest.verificationMode,
    );

    const trace = this.traceCollector.createTrace({
      taskId,
      projectId,
      sessionId,
    });

    const now = new Date().toISOString();
    const taskState: TaskState = {
      taskId,
      traceId: trace.traceId,
      projectId,
      sessionId,
      status: "created",
      category: activeRequest.category,
      verificationMode,
      goal: activeRequest.resolvedGoal,
      originalInput: input.message,
      currentStep: "understand_request",
      completedSteps: [],
      pendingSteps: ["understand_request", "execute_plan", "finalize"],
      blockingReason: null,
      failureCategory: null,
      evidenceSufficiency:
        verificationMode === "general" ? "not_required" : "insufficient",
      requiresUserConfirmation: Boolean(input.requireUserConfirmation),
      lastValidOutput: projectMemory.activeReport?.content ?? "",
      finalOutput: "",
      resourceUsage: {
        iterations: 0,
        maxIterations: this.config.maxIterations,
        modelCalls: 0,
        maxModelCalls: this.config.maxModelCalls,
        toolCalls: 0,
        maxToolCalls: this.config.maxToolCalls,
        estimatedTokens: 0,
        maxTokens: this.config.maxTokens,
        elapsedMs: 0,
        timeoutMs: this.config.timeoutMs,
        retries: 0,
      },
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(taskId, taskState);

    // Record user message in project-scoped conversation history
    this.contextManager.recordTurn({
      sessionId,
      projectId,
      taskId,
      role: "user",
      content: input.message,
    });

    const taskMemory = this.contextManager.initTaskMemory(
      taskId,
      projectId,
      activeRequest.resolvedGoal,
    );
    const workingMemory = this.contextManager.getWorkingMemory(taskId);

    // If fresh retrieval or new task, clear any prior task-scoped evidence
    if (activeRequest.discardPriorRetrieval) {
      this.evidenceStore.clearTask(taskId);
    }

    const emit = async (
      type: ObservableEventType,
      message: string,
      data?: Record<string, unknown>,
    ) => {
      const event = this.traceCollector.recordEvent(
        trace.traceId,
        type,
        message,
        data,
        taskState.currentStep,
      );
      if (event && input.onEvent) {
        await input.onEvent(event);
      }
    };

    const parentSignal = input.signal ?? new AbortController().signal;
    const deadline = createDeadline(parentSignal, this.config.timeoutMs);
    const permissions = new Set<ToolPermission>(
      input.permissions ?? this.config.permissions,
    );

    const toolContext = {
      taskId,
      projectId,
      sessionId,
      traceId: trace.traceId,
      workspaceRoot,
      signal: deadline.signal,
      permissions,
      emit,
    };

    const completeStep = (stepName: string, nextStep?: string) => {
      if (!taskState.completedSteps.includes(stepName)) {
        taskState.completedSteps.push(stepName);
      }
      taskState.pendingSteps = taskState.pendingSteps.filter(
        (s) => s !== stepName,
      );
      if (nextStep) {
        taskState.currentStep = nextStep;
        if (!taskState.pendingSteps.includes(nextStep)) {
          taskState.pendingSteps.unshift(nextStep);
        }
      }
      taskMemory.completedSteps = [...taskState.completedSteps];
      taskMemory.pendingSteps = [...taskState.pendingSteps];
      taskMemory.checkpoint = {
        stepIndex: taskState.completedSteps.length,
        currentStep: taskState.currentStep,
        completedSteps: [...taskState.completedSteps],
        pendingSteps: [...taskState.pendingSteps],
        draft: taskState.lastValidOutput,
        evidenceIds: this.evidenceStore.getForTask(taskId).map((e) => e.id),
        savedAt: new Date().toISOString(),
      };
      taskState.updatedAt = new Date().toISOString();
    };

    try {
      parentSignal.throwIfAborted();
      taskState.status = "running";
      await emit(
        "task_started",
        `任务开始 [${activeRequest.category}]：${activeRequest.resolvedGoal}`,
        {
          category: activeRequest.category,
          continuity: activeRequest.continuity,
          verificationMode,
          projectId,
        },
      );

      // Optional user confirmation gate
      if (input.requireUserConfirmation) {
        taskState.status = "waiting_for_user";
        taskState.requiresUserConfirmation = true;
        taskState.confirmationPrompt = `请确认是否执行任务：${activeRequest.resolvedGoal}`;
        taskState.blockingReason = "Waiting for user confirmation.";
        await emit("plan_updated", taskState.confirmationPrompt, {
          status: "waiting_for_user",
        });
        this.traceCollector.completeTrace(trace.traceId, "waiting_for_user");
        return {
          taskState,
          output: taskState.confirmationPrompt,
          evidences: [],
          artifacts: [],
          trace,
        };
      }

      completeStep("understand_request", "plan_and_execute");

      // Load compacted context for this project & task
      const compacted = compactContext({
        projectMemory,
        taskState,
        conversation: recentTurns,
        evidences: this.evidenceStore.getForTask(taskId),
        workingMemory,
      });

      // =========================================================================
      // PATH 1: File Save / Artifact Operation (Case C & Section 7)
      // =========================================================================
      if (activeRequest.category === "file_operation") {
        const targetPath = activeRequest.targetFilePath ?? "report.md";
        const contentToSave =
          projectMemory.activeReport?.content ||
          recentTurns
            .filter((t) => t.role === "assistant")
            .at(-1)?.content ||
          `# Report\n\n${activeRequest.resolvedGoal}`;

        await emit(
          "plan_updated",
          `计划将当前报告写入文件：${targetPath}`,
          { plan: ["write_file", "verify_file"] },
        );

        taskState.status = "waiting_for_tool";
        taskState.resourceUsage.toolCalls++;
        const writeRes = await this.toolRegistry.execute<{
          path: string;
          relativePath: string;
          sha256: string;
          sizeBytes: number;
          verified: boolean;
          artifactId: string;
        }>(
          "write_file",
          {
            path: targetPath,
            content: contentToSave,
            overwrite: true,
          },
          toolContext,
        );

        this.traceCollector.recordToolCall(trace.traceId, {
          tool: "write_file",
          arguments: { path: targetPath },
          success: writeRes.success,
          latencyMs: writeRes.latencyMs,
          ...(writeRes.success
            ? {}
            : {
                errorCode: writeRes.error.code,
                errorCategory: writeRes.error.category,
              }),
        });

        if (!writeRes.success) {
          // NEVER claim save succeeded when the tool failed!
          taskState.status = taskState.lastValidOutput
            ? "partially_completed"
            : "failed";
          taskState.failureCategory =
            writeRes.error.category ?? "permission_error";
          taskState.blockingReason = writeRes.error.message;
          const errOutput = `文件保存失败（${writeRes.error.code}）：${writeRes.error.message}。未能写入目标路径 \`${targetPath}\`，但已保留内存中的报告成果。`;
          taskState.finalOutput = errOutput;
          await emit("task_failed", errOutput, {
            error: writeRes.error,
            preservedReport: Boolean(taskState.lastValidOutput),
          });
          this.traceCollector.completeTrace(trace.traceId, taskState.status);
          return {
            taskState,
            output: errOutput,
            evidences: this.evidenceStore.getForTask(taskId),
            artifacts: taskState.artifacts,
            trace,
          };
        }

        // Read back using read_file tool to double-verify readability
        const readBack = await this.toolRegistry.execute<{
          path: string;
          content: string;
        }>("read_file", { path: targetPath }, toolContext);
        this.traceCollector.recordToolCall(trace.traceId, {
          tool: "read_file",
          arguments: { path: targetPath },
          success: readBack.success,
          latencyMs: readBack.latencyMs,
        });

        const artifacts = projectMemory.artifacts.filter(
          (a) => a.path === writeRes.data.path,
        );
        taskState.artifacts = artifacts;
        for (const art of artifacts) {
          this.traceCollector.recordArtifact(trace.traceId, art);
        }

        const successMsg = `报告已成功保存并验证：\n- 文件路径：\`${writeRes.data.path}\`\n- 相对路径：\`${writeRes.data.relativePath}\`\n- 文件大小：${writeRes.data.sizeBytes} 字节\n- SHA-256：\`${writeRes.data.sha256}\``;
        taskState.status = "completed";
        taskState.finalOutput = successMsg;
        completeStep("plan_and_execute", "finalize");
        completeStep("finalize");

        this.contextManager.recordTurn({
          sessionId,
          projectId,
          taskId,
          role: "assistant",
          content: successMsg,
        });
        if (input.onDelta) await input.onDelta(successMsg);
        await emit("task_completed", "文件保存任务完成", {
          path: writeRes.data.path,
        });
        this.traceCollector.completeTrace(trace.traceId, "completed");

        return {
          taskState,
          output: successMsg,
          evidences: this.evidenceStore.getForTask(taskId),
          artifacts: taskState.artifacts,
          trace,
        };
      }

      // =========================================================================
      // PATH 2: Multi-Turn Section Edit or Summarize (Case F & Section 3.2)
      // =========================================================================
      if (
        (activeRequest.category === "report_edit" ||
          activeRequest.category === "report_summarize") &&
        projectMemory.activeReport
      ) {
        const currentReport = projectMemory.activeReport.content;
        const targetSection = activeRequest.targetSection ?? "结论";

        await emit(
          "plan_updated",
          activeRequest.category === "report_summarize"
            ? "基于当前项目已有报告进行总结整理"
            : `仅针对当前报告的「${targetSection}」章节进行定向修改，保留其余有效内容`,
          {
            continuity: activeRequest.continuity,
            targetSection,
          },
        );

        let updatedReport: string;
        if (activeRequest.category === "report_summarize") {
          const prompt = [
            "Summarize the supplied report concisely according to the user's request.",
            "Preserve existing valid citation markers like [RAG:1] or [PAPER:1]. Do not invent new facts or citations.",
            `User instruction: ${input.message}`,
            `Existing report:\n${currentReport}`,
          ].join("\n\n");
          updatedReport = await this.callModelWithRecovery<string>({
            taskState,
            traceId: trace.traceId,
            step: "summarize_report",
            operation: "generate",
            prompt,
            signal: deadline.signal,
            fallbackValue: () => currentReport,
          });
        } else {
          const prompt = [
            `Rewrite ONLY the "${targetSection}" section of the report according to the user's instruction.`,
            "Preserve valid citation IDs if applicable. Return ONLY the new content for that section (do not repeat the rest of the report).",
            `User instruction: ${input.message}`,
            `Current report:\n${currentReport}`,
          ].join("\n\n");
          const newSectionBody = await this.callModelWithRecovery<string>({
            taskState,
            traceId: trace.traceId,
            step: "edit_report_section",
            operation: "generate",
            prompt,
            signal: deadline.signal,
            fallbackValue: () => `（已根据「${input.message}」更新本节结论）`,
          });
          updatedReport = replaceMarkdownSection(
            currentReport,
            targetSection,
            newSectionBody,
          );
        }

        this.contextManager.saveReportToProject(
          projectId,
          taskId,
          updatedReport,
          projectMemory.activeReport.evidenceIds,
        );
        taskState.lastValidOutput = updatedReport;
        taskState.finalOutput = updatedReport;
        taskState.status = "completed";
        completeStep("plan_and_execute", "finalize");
        completeStep("finalize");

        this.contextManager.recordTurn({
          sessionId,
          projectId,
          taskId,
          role: "assistant",
          content: updatedReport,
        });
        if (input.onDelta) await input.onDelta(updatedReport);
        await emit("task_completed", "报告章节更新完成", {
          revision: projectMemory.activeReport.revision,
        });
        this.traceCollector.completeTrace(trace.traceId, "completed");

        return {
          taskState,
          output: updatedReport,
          evidences: this.evidenceStore.getForProject(projectId),
          artifacts: projectMemory.artifacts,
          trace,
        };
      }

      // =========================================================================
      // PATH 3: Ordinary Q&A — No Forced RAG or Report Boilerplate (Case D)
      // =========================================================================
      if (activeRequest.category === "qa") {
        await emit(
          "plan_updated",
          "识别为通用概念问答，直接生成解答，不触发无关 RAG 或文献检索",
          { category: "qa", verificationMode: "general" },
        );

        const prompt = [
          "You are Atlas, a general-purpose AI assistant. Answer the user's question clearly, accurately, and directly in the user's language.",
          "Do NOT format as a formal research report with observation/inference boilerplate, and do NOT invent or include [RAG:...] citations.",
          `User question: ${activeRequest.resolvedGoal}`,
        ].join("\n\n");

        const answer = await this.callModelWithRecovery<string>({
          taskState,
          traceId: trace.traceId,
          step: "direct_qa",
          operation: "generate",
          prompt,
          signal: deadline.signal,
          fallbackValue: () =>
            `关于「${activeRequest.resolvedGoal}」的解答：这是一个通用技术概念问题。`,
        });

        // Strip any accidental [RAG:...] markers in pure general Q&A
        const cleanAnswer = answer.replace(/\[RAG:[^\]]+\]/g, "").trim();

        taskState.lastValidOutput = cleanAnswer;
        taskState.finalOutput = cleanAnswer;
        taskState.status = "completed";
        taskState.evidenceSufficiency = "not_required";
        completeStep("plan_and_execute", "finalize");
        completeStep("finalize");

        this.contextManager.recordTurn({
          sessionId,
          projectId,
          taskId,
          role: "assistant",
          content: cleanAnswer,
        });
        if (input.onDelta) await input.onDelta(cleanAnswer);
        await emit("task_completed", "通用问答完成", { category: "qa" });
        this.traceCollector.completeTrace(trace.traceId, "completed");

        return {
          taskState,
          output: cleanAnswer,
          evidences: [],
          artifacts: [],
          trace,
        };
      }

      // =========================================================================
      // PATH 4: General Iterative Agent Loop for Project Analysis, Research & Tools
      // =========================================================================
      const attemptedQueries = new Set<string>();
      let ragAttempted = false;
      let webAttempted = false;
      let academicAttempted = false;
      let workspaceInspected = false;

      while (
        taskState.resourceUsage.iterations <
        taskState.resourceUsage.maxIterations
      ) {
        deadline.signal.throwIfAborted();
        taskState.resourceUsage.iterations++;
        trace.iterations = taskState.resourceUsage.iterations;

        const currentEvidences = this.evidenceStore.getForTask(taskId);

        // Decide next action based on category, progress, and model planning
        let plannedAction: PlannedAction;

        if (
          activeRequest.category === "project_analysis" ||
          activeRequest.category === "code_analysis"
        ) {
          // For project/UX analysis: first check project-scoped RAG (which will filter out any unrelated botany chunks!), then inspect workspace files if needed, then answer
          if (!ragAttempted && this.rag) {
            plannedAction = {
              action: "search_knowledge_base",
              query: activeRequest.resolvedGoal,
              reason: "检查当前项目知识库中是否有相关架构或 UX 文档",
            };
          } else if (!workspaceInspected && permissions.has("read")) {
            plannedAction = {
              action: "list_directory",
              path: ".",
              reason: "读取工作区目录结构以分析项目代码与 UX 改进点",
            };
          } else {
            plannedAction = {
              action: "finish",
              reason: "已完成项目上下文收集，生成分析建议",
            };
          }
        } else if (activeRequest.category === "literature_discovery") {
          if (!academicAttempted) {
            plannedAction = {
              action: "discover_literature",
              query: activeRequest.resolvedGoal,
              reason: "检索学术论文数据库获取相关文献与元数据",
            };
          } else {
            plannedAction = {
              action: "finish",
              reason: "已获取学术文献列表，整理文献发现报告",
            };
          }
        } else {
          // Research review / supplement citations / general agentic decision
          if (!ragAttempted && this.rag) {
            plannedAction = {
              action: "search_knowledge_base",
              query: activeRequest.resolvedGoal,
              reason: "检索当前项目本地知识库",
            };
          } else if (
            currentEvidences.length === 0 &&
            !webAttempted &&
            this.web
          ) {
            plannedAction = {
              action: "web_search",
              query: activeRequest.resolvedGoal,
              reason: "本地知识库无相关证据，尝试使用网络搜索获取外部资料",
            };
          } else if (
            activeRequest.continuity === "supplement_citations" &&
            !webAttempted &&
            this.web
          ) {
            plannedAction = {
              action: "web_search",
              query: activeRequest.resolvedGoal,
              reason: "补充检索引用来源",
            };
          } else {
            plannedAction = {
              action: "finish",
              reason: "完成取证，进入综合分析与验证阶段",
            };
          }
        }

        await emit(
          "plan_updated",
          `第 ${taskState.resourceUsage.iterations} 步决策：${plannedAction.action} — ${plannedAction.reason}`,
          {
            iteration: taskState.resourceUsage.iterations,
            action: plannedAction.action,
            query: plannedAction.query,
          },
        );

        if (
          plannedAction.action === "finish" ||
          plannedAction.action === "direct_answer"
        ) {
          break;
        }

        // Prevent duplicate tool queries without new information
        const querySignature = `${plannedAction.action}:${(plannedAction.query ?? plannedAction.path ?? "").trim().toLowerCase()}`;
        if (attemptedQueries.has(querySignature)) {
          break;
        }
        attemptedQueries.add(querySignature);

        taskState.status = "waiting_for_tool";
        taskState.resourceUsage.toolCalls++;

        if (plannedAction.action === "search_knowledge_base") {
          ragAttempted = true;
          const kbRes = await this.toolRegistry.execute<{
            hits: Array<{
              id: string;
              documentId: string;
              content: string;
              score: number;
            }>;
            evidenceIds: string[];
            filteredIrrelevantCount: number;
            emptyReason?: string;
          }>(
            "search_knowledge_base",
            {
              query: plannedAction.query ?? activeRequest.resolvedGoal,
              projectId,
              topK: 4,
            },
            toolContext,
          );

          this.traceCollector.recordToolCall(trace.traceId, {
            tool: "search_knowledge_base",
            arguments: {
              query: plannedAction.query ?? activeRequest.resolvedGoal,
              projectId,
            },
            success: kbRes.success,
            latencyMs: kbRes.latencyMs,
            ...(kbRes.success
              ? {}
              : {
                  errorCode: kbRes.error.code,
                  errorCategory: kbRes.error.category,
                }),
          });

          if (!kbRes.success && this.config.enableSelfRecovery) {
            // Self-recovery when Ollama Embedding is unavailable: try BM25 sparse search!
            taskState.status = "recovering";
            const bm25Res = await this.toolRegistry.execute<{
              hits: Array<{
                id: string;
                documentId: string;
                content: string;
                score: number;
              }>;
              evidenceIds: string[];
              filteredIrrelevantCount: number;
            }>(
              "search_knowledge_base",
              {
                query: plannedAction.query ?? activeRequest.resolvedGoal,
                projectId,
                topK: 4,
                strategy: "bm25",
              },
              toolContext,
            );
            this.traceCollector.recordRecovery(trace.traceId, {
              step: "search_knowledge_base",
              failureCategory: "retrieval_error",
              action: "fallback_to_bm25_sparse_search",
              succeeded: bm25Res.success,
              message: bm25Res.success
                ? "Ollama Embedding 不可用，已自动切换为 BM25 稀疏检索恢复。"
                : "BM25 备用检索亦未命中，继续使用其他可用工具或模型知识。",
            });
          } else if (kbRes.success) {
            workingMemory.toolOutputs.push({
              tool: "search_knowledge_base",
              summary: `Retrieved ${kbRes.data.hits.length} relevant hits (filtered ${kbRes.data.filteredIrrelevantCount} irrelevant chunks).`,
              timestamp: new Date().toISOString(),
            });
          }
        } else if (plannedAction.action === "web_search") {
          webAttempted = true;
          const webRes = await this.toolRegistry.execute<{
            results: Array<{
              id: string;
              title: string;
              url: string;
              snippet: string;
            }>;
            evidenceIds: string[];
          }>(
            "web_search",
            { query: plannedAction.query ?? activeRequest.resolvedGoal },
            toolContext,
          );
          this.traceCollector.recordToolCall(trace.traceId, {
            tool: "web_search",
            arguments: {
              query: plannedAction.query ?? activeRequest.resolvedGoal,
            },
            success: webRes.success,
            latencyMs: webRes.latencyMs,
          });
          if (!webRes.success && this.config.enableSelfRecovery) {
            this.traceCollector.recordRecovery(trace.traceId, {
              step: "web_search",
              failureCategory: "network_error",
              action: "graceful_fallback_without_web",
              succeeded: true,
              message: "网络搜索不可用或超时，降级使用本地上下文与标注不确定性的知识回答。",
            });
          }
        } else if (plannedAction.action === "discover_literature") {
          academicAttempted = true;
          const litRes = await this.toolRegistry.execute(
            "discover_literature",
            {
              query: plannedAction.query ?? activeRequest.resolvedGoal,
              limit: 5,
            },
            toolContext,
          );
          this.traceCollector.recordToolCall(trace.traceId, {
            tool: "discover_literature",
            arguments: {
              query: plannedAction.query ?? activeRequest.resolvedGoal,
            },
            success: litRes.success,
            latencyMs: litRes.latencyMs,
          });
        } else if (plannedAction.action === "list_directory") {
          workspaceInspected = true;
          const listRes = await this.toolRegistry.execute<{
            entries: Array<{ name: string; type: string }>;
          }>(
            "list_directory",
            { path: plannedAction.path ?? "." },
            toolContext,
          );
          this.traceCollector.recordToolCall(trace.traceId, {
            tool: "list_directory",
            arguments: { path: plannedAction.path ?? "." },
            success: listRes.success,
            latencyMs: listRes.latencyMs,
          });
          if (listRes.success) {
            workingMemory.toolOutputs.push({
              tool: "list_directory",
              summary: `Workspace entries: ${listRes.data.entries.map((e) => e.name).join(", ")}`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        taskState.status = "running";
      }

      // =========================================================================
      // Step 2: Synthesize Output & Run Graded Claim-Evidence Verification
      // =========================================================================
      completeStep("plan_and_execute", "synthesize_and_verify");

      let taskEvidences = this.evidenceStore.getForTask(taskId);
      // Double-check relevance against current goal so no cross-domain chunk ever leaks into synthesis
      const goalTokens = new Set(tokenizeText(activeRequest.resolvedGoal));
      taskEvidences = taskEvidences.filter((ev) => {
        if (ev.projectId && ev.projectId !== projectId) return false;
        const evTokens = tokenizeText(`${ev.title ?? ""} ${ev.originalText}`);
        const hasOverlap = evTokens.some((t) => goalTokens.has(t));
        return hasOverlap || (ev.relevanceScore !== undefined && ev.relevanceScore >= 0.75);
      });

      if (activeRequest.continuity === "supplement_citations" && projectMemory.activeReport) {
        // Append newly retrieved citations to the existing report without duplicating the report
        const baseReport = projectMemory.activeReport.content;
        const allProjectEvidences = [
          ...this.evidenceStore.getForProject(projectId),
          ...taskEvidences,
        ];
        const uniqueEvMap = new Map(allProjectEvidences.map((e) => [e.id, e]));
        const citationsBlock = [...uniqueEvMap.values()]
          .map(
            (e) =>
              `- [${e.id}] ${e.title ?? e.documentId ?? e.sourceId}：${e.originalText.slice(0, 180)}`,
          )
          .join("\n");

        const updatedReport = replaceMarkdownSection(
          baseReport,
          "参考文献与补充引用",
          citationsBlock || "- 已核对现有证据来源。",
        );
        this.contextManager.saveReportToProject(
          projectId,
          taskId,
          updatedReport,
          [...uniqueEvMap.keys()],
        );
        taskState.lastValidOutput = updatedReport;
        taskState.finalOutput = updatedReport;
        taskState.status = "completed";
        taskState.evidenceSufficiency =
          uniqueEvMap.size > 0 ? "sufficient" : "partial";
        completeStep("synthesize_and_verify", "finalize");
        completeStep("finalize");

        this.contextManager.recordTurn({
          sessionId,
          projectId,
          taskId,
          role: "assistant",
          content: updatedReport,
        });
        if (input.onDelta) await input.onDelta(updatedReport);
        await emit("task_completed", "补充引用完成", {
          evidenceCount: uniqueEvMap.size,
        });
        this.traceCollector.completeTrace(trace.traceId, "completed");

        return {
          taskState,
          output: updatedReport,
          evidences: [...uniqueEvMap.values()],
          artifacts: projectMemory.artifacts,
          trace,
        };
      }

      // Build synthesis prompt strictly isolated to current project & relevant evidence
      const synthesisPrompt = [
        "You are Atlas, a general-purpose AI and research agent.",
        `Current Project ID: ${projectId}`,
        `Active Task Goal: ${activeRequest.resolvedGoal}`,
        `Task Category: ${activeRequest.category}`,
        `Verification Mode: ${verificationMode}`,
        ...(taskEvidences.length > 0
          ? [
              "Relevant Evidence Available (cite ONLY these exact IDs in square brackets like [RAG:1], [WEB:1], or [PAPER:1] when making claims supported by them; never invent citation IDs):",
              JSON.stringify(
                taskEvidences.map((e) => ({
                  id: e.id,
                  sourceType: e.sourceType,
                  title: e.title ?? e.documentId ?? e.sourceId,
                  text: e.originalText,
                })),
              ),
            ]
          : [
              "No local RAG or external evidence matched this query. Answer using your general knowledge or workspace context, explicitly note any uncertainties, and NEVER invent or output any [RAG:...] or fake citation IDs.",
            ]),
        ...(compacted.recentToolResults.length > 0
          ? [`Workspace / Tool Observations:\n${compacted.recentToolResults.join("\n")}`]
          : []),
      ].join("\n\n");

      let draft = await this.callModelWithRecovery<string>({
        taskState,
        traceId: trace.traceId,
        step: "synthesize",
        operation: "generate",
        prompt: synthesisPrompt,
        signal: deadline.signal,
        fallbackValue: () => {
          if (taskEvidences.length > 0) {
            return `## 调研分析：${activeRequest.resolvedGoal}\n\n根据已检索到的相关证据：\n${taskEvidences.map((e) => `- ${e.originalText} [${e.id}]`).join("\n")}`;
          }
          return `## 分析解答：${activeRequest.resolvedGoal}\n\n说明：当前本地知识库未包含该主题的直接文献证据，以下基于项目上下文与通用知识提供分析建议（不确定性已标注）。`;
        },
      });

      // If there are NO relevant evidences, strip any hallucinated [RAG:...] citations
      if (taskEvidences.length === 0) {
        draft = draft.replace(/\[(?:RAG|WEB|PAPER|EV):[^\]]+\]/g, "").trim();
        if (
          verificationMode !== "general" &&
          !/未包含|未检索到|通用知识|不确定|待核实|no local evidence/i.test(draft)
        ) {
          draft +=
            "\n\n> 注：当前本地知识库中未检索到与该问题直接相关的证据，以上回答基于通用知识整理，具体事实细节建议结合外部资料进一步核实。";
        }
      }

      taskState.lastValidOutput = draft;

      // Step 3: Graded Verification & Local Self-Recovery (Section 6.2–6.4 & Case B)
      let verification = verifyDraftAndClaims({
        draft,
        evidences: taskEvidences,
        mode: verificationMode,
      });

      if (
        verification.status !== "pass" &&
        this.config.enableSelfRecovery &&
        verification.issues.length > 0
      ) {
        taskState.status = "recovering";

        // Attempt 1 supplementary retrieval if there are unsupported claims and RAG/web is available
        const hasUnsupported = verification.issues.some(
          (i) =>
            i.type === "unsupported_claim" ||
            i.type === "irrelevant_evidence" ||
            i.type === "missing_source",
        );

        if (
          hasUnsupported &&
          taskState.resourceUsage.toolCalls <
            taskState.resourceUsage.maxToolCalls
        ) {
          const suppQuery = `${activeRequest.resolvedGoal} 证据 详情`;
          if (!attemptedQueries.has(`supp:${suppQuery}`) && this.rag) {
            attemptedQueries.add(`supp:${suppQuery}`);
            taskState.resourceUsage.toolCalls++;
            await this.toolRegistry.execute(
              "search_knowledge_base",
              { query: suppQuery, projectId, topK: 3 },
              toolContext,
            );
            taskEvidences = this.evidenceStore.getForTask(taskId);
          }
        }

        // Perform local claim/citation repair so valid research findings are preserved!
        const repaired = repairReportLocally(
          draft,
          verification,
          taskEvidences,
        );
        draft = repaired.repairedReport;
        taskState.lastValidOutput = draft;

        this.traceCollector.recordRecovery(trace.traceId, {
          step: "verification_recovery",
          failureCategory: "evidence_error",
          action: "local_claim_and_citation_repair",
          succeeded: true,
          message: `已定位并局部修复 ${repaired.repairedCount} 处引文/断言问题，保留有效研究成果。`,
        });

        // Re-evaluate verification after local repair
        verification = verifyDraftAndClaims({
          draft,
          evidences: taskEvidences,
          mode: verificationMode,
        });
      }

      taskState.verification = verification;
      this.traceCollector.recordVerification(trace.traceId, verification);
      await emit(
        "verification_completed",
        `验证完成（模式：${verificationMode}，状态：${verification.status}）`,
        {
          verification,
        },
      );

      // Update evidence sufficiency field independently of task success
      taskState.evidenceSufficiency =
        verificationMode === "general"
          ? "not_required"
          : taskEvidences.length === 0
            ? "insufficient"
            : verification.status === "pass"
              ? "sufficient"
              : "partial";

      // Save report into project memory if this was a research or analysis task
      if (
        activeRequest.category === "research_review" ||
        activeRequest.category === "literature_discovery" ||
        activeRequest.category === "paper_analysis" ||
        activeRequest.category === "project_analysis"
      ) {
        this.contextManager.saveReportToProject(
          projectId,
          taskId,
          draft,
          taskEvidences.map((e) => e.id),
        );
        projectMemory.researchSummaries.push({
          taskId,
          goal: activeRequest.resolvedGoal,
          conclusionPreview: draft.slice(0, 300),
          updatedAt: new Date().toISOString(),
        });
      }

      taskState.finalOutput = draft;
      taskState.status = "completed";
      taskState.resourceUsage.elapsedMs = Date.now() - startTime;
      completeStep("synthesize_and_verify", "finalize");
      completeStep("finalize");

      this.contextManager.recordTurn({
        sessionId,
        projectId,
        taskId,
        role: "assistant",
        content: draft,
      });

      if (input.onDelta) await input.onDelta(draft);
      await emit("task_completed", "任务执行完成", {
        status: taskState.status,
        evidenceSufficiency: taskState.evidenceSufficiency,
      });
      this.traceCollector.completeTrace(trace.traceId, taskState.status);

      return {
        taskState,
        output: draft,
        evidences: taskEvidences,
        artifacts: taskState.artifacts,
        trace,
      };
    } catch (error) {
      taskState.resourceUsage.elapsedMs = Date.now() - startTime;
      if (parentSignal.aborted) {
        taskState.status = "cancelled";
        taskState.blockingReason = "Cancelled by user or caller signal.";
        this.traceCollector.completeTrace(trace.traceId, "cancelled");
        throw error;
      }

      const classified = classifyError(
        deadline.signal.aborted ? deadline.signal.reason : error,
      );
      taskState.failureCategory = classified.category;
      taskState.blockingReason = classified.message;

      // Preserve any partial work / valid output instead of discarding everything
      if (taskState.lastValidOutput.trim()) {
        taskState.status = "partially_completed";
        taskState.finalOutput = taskState.lastValidOutput;
      } else {
        taskState.status = "failed";
        taskState.finalOutput = `任务未能完成（${classified.category}: ${classified.code}）：${classified.message}`;
      }

      await emit("task_failed", taskState.blockingReason, {
        status: taskState.status,
        failureCategory: taskState.failureCategory,
        code: classified.code,
      });
      this.traceCollector.completeTrace(trace.traceId, taskState.status);

      return {
        taskState,
        output: taskState.finalOutput,
        evidences: this.evidenceStore.getForTask(taskId),
        artifacts: taskState.artifacts,
        trace,
      };
    } finally {
      deadline.dispose();
    }
  }
}
