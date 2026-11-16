import type { z } from "zod";

/**
 * 2.2 Explicit Task State Machine
 */
export type TaskStatus =
  | "created"
  | "running"
  | "waiting_for_tool"
  | "waiting_for_user"
  | "recovering"
  | "completed"
  | "partially_completed"
  | "failed"
  | "cancelled";

/**
 * 2.4 Error Classification for Self-Recovery
 */
export type FailureCategory =
  | "tool_error"
  | "network_error"
  | "model_error"
  | "schema_error"
  | "retrieval_error"
  | "evidence_error"
  | "permission_error"
  | "budget_exceeded"
  | "unrecoverable_error";

/**
 * 6.4 Graded Verification Strategy
 */
export type VerificationMode = "general" | "research" | "strict_research";

/**
 * 2.3 User Intent & Task Categories
 */
export type TaskCategory =
  | "qa"
  | "file_operation"
  | "code_analysis"
  | "project_analysis"
  | "literature_discovery"
  | "research_review"
  | "paper_analysis"
  | "report_edit"
  | "report_summarize"
  | "clarify";

export type EvidenceSufficiency =
  | "not_required"
  | "sufficient"
  | "partial"
  | "insufficient";

/**
 * 10.1 Observable Execution Events
 */
export type ObservableEventType =
  | "task_started"
  | "plan_updated"
  | "tool_started"
  | "tool_completed"
  | "tool_failed"
  | "evidence_added"
  | "verification_completed"
  | "artifact_created"
  | "task_completed"
  | "task_failed";

export interface ObservableEvent {
  id: string;
  traceId: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  sequence: number;
  timestamp: string;
  type: ObservableEventType;
  step?: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * 6.1 Unified Evidence Store Item
 */
export interface Evidence {
  id: string;
  taskId: string;
  projectId?: string;
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
    startLine?: number;
    endLine?: number;
  };
  retrievedAt: string;
  relevanceScore?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 6.2 & 6.3 Claim & Verification Result
 */
export interface Claim {
  id: string;
  text: string;
  strength: "strong" | "moderate" | "tentative";
  evidenceIds: string[];
  relation: "supporting" | "contradicting" | "insufficient";
}

export interface VerificationIssue {
  claimId?: string;
  evidenceId?: string;
  type:
    | "missing_source"
    | "unlocatable_quote"
    | "irrelevant_evidence"
    | "unsupported_claim"
    | "contradictory_evidence"
    | "overstated_inference"
    | "abstract_only_limitation";
  message: string;
  recoverable: boolean;
  suggestedAction?:
    | "remove_citation"
    | "supplement_retrieval"
    | "weaken_claim"
    | "annotate_abstract_only"
    | "present_conflicting_views"
    | "mark_uncertainty";
}

export interface VerificationResult {
  status: "pass" | "partial" | "fail";
  mode: VerificationMode;
  issues: VerificationIssue[];
  claims?: Claim[];
}

/**
 * 3.1 & 7 Artifact State
 */
export interface ArtifactRecord {
  id: string;
  taskId: string;
  projectId: string;
  path: string;
  relativePath: string;
  kind: "markdown_report" | "research_note" | "code" | "data" | "file";
  sha256: string;
  sizeBytes: number;
  createdAt: string;
  updatedAt: string;
  contentPreview?: string;
  diffSummary?: string;
}

/**
 * 2.2 Resource Usage & Independent Task State Fields
 */
export interface ResourceUsage {
  iterations: number;
  maxIterations: number;
  modelCalls: number;
  maxModelCalls: number;
  toolCalls: number;
  maxToolCalls: number;
  estimatedTokens: number;
  maxTokens: number;
  elapsedMs: number;
  timeoutMs: number;
  retries: number;
}

export interface TaskState {
  taskId: string;
  traceId: string;
  projectId: string;
  sessionId: string;
  status: TaskStatus;
  category: TaskCategory;
  verificationMode: VerificationMode;
  goal: string;
  originalInput: string;
  currentStep: string;
  completedSteps: string[];
  pendingSteps: string[];
  blockingReason: string | null;
  failureCategory: FailureCategory | null;
  evidenceSufficiency: EvidenceSufficiency;
  requiresUserConfirmation: boolean;
  confirmationPrompt?: string;
  lastValidOutput: string;
  finalOutput: string;
  resourceUsage: ResourceUsage;
  artifacts: ArtifactRecord[];
  verification?: VerificationResult;
  createdAt: string;
  updatedAt: string;
}

/**
 * 9. Unified Tool Contract
 */
export type ToolPermission = "none" | "read" | "write" | "network" | "shell";

export type ToolResult<T = unknown> =
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
        category?: FailureCategory;
      };
    };

export interface ToolExecutionContext {
  taskId: string;
  projectId: string;
  sessionId: string;
  traceId: string;
  workspaceRoot: string;
  signal: AbortSignal;
  permissions: Set<ToolPermission>;
  emit?: (
    type: ObservableEventType,
    message: string,
    data?: Record<string, unknown>,
  ) => Promise<void>;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  permission: ToolPermission;
  timeoutMs: number;
  errorTypes: FailureCategory[];
  retryable: boolean;
  sideEffects: boolean;
  cancellable: boolean;
  execute(
    input: TInput,
    context: ToolExecutionContext,
  ): Promise<ToolResult<TOutput>>;
}
