import { randomUUID } from "node:crypto";
import type { RerankRecord } from "../rag/hybrid.js";
import type {
  ArtifactRecord,
  FailureCategory,
  ObservableEvent,
  ObservableEventType,
  TaskStatus,
  VerificationResult,
} from "./types.js";

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{12,}/g,
  /Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi,
  /(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[a-zA-Z0-9._-]{8,}["']?/gi,
];

/**
 * 12. Redact sensitive API keys, tokens, and secrets from logs and trace payloads.
 */
export function redactSensitiveText(input: string): string {
  let result = input;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  const envSecrets = [
    process.env.OPENAI_API_KEY,
    process.env.BRAVE_SEARCH_API_KEY,
    process.env.SEMANTIC_SCHOLAR_API_KEY,
  ].filter((v): v is string => Boolean(v && v.trim().length >= 6));
  for (const secret of envSecrets) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
  return result;
}

export function redactObject<T>(value: T): T {
  const serialized = JSON.stringify(value, (key, val) => {
    if (
      typeof key === "string" &&
      /^(api[_-]?key|authorization|x-subscription-token|secret|password|token)$/i.test(
        key,
      )
    ) {
      return "[REDACTED]";
    }
    if (typeof val === "string") {
      return redactSensitiveText(val);
    }
    return val;
  });
  return serialized ? (JSON.parse(serialized) as T) : value;
}

export interface ModelCallTrace {
  step: string;
  provider: string;
  model: string;
  operation: "generate" | "stream" | "structuredOutput";
  inputTokensEstimate: number;
  outputTokensEstimate: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
}

export interface ToolCallTrace {
  tool: string;
  arguments: Record<string, unknown>;
  success: boolean;
  latencyMs: number;
  errorCode?: string;
  errorCategory?: FailureCategory;
}

export interface RetrievalTrace {
  query: string;
  rewrittenQueries: string[];
  strategy: string;
  hitCount: number;
  filteredIrrelevantCount: number;
  hitIds: string[];
}

export interface RecoveryTrace {
  step: string;
  failureCategory: FailureCategory;
  action: string;
  succeeded: boolean;
  message: string;
  timestamp: string;
}

export interface TaskTrace {
  traceId: string;
  taskId: string;
  projectId: string;
  sessionId: string;
  status: TaskStatus;
  iterations: number;
  modelCalls: ModelCallTrace[];
  totalTokensEstimate: number;
  toolCalls: ToolCallTrace[];
  retrievals: RetrievalTrace[];
  rerankResults: RerankRecord[];
  verification?: VerificationResult;
  recoveries: RecoveryTrace[];
  artifacts: ArtifactRecord[];
  events: ObservableEvent[];
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
}

export class TraceCollector {
  private readonly traces = new Map<string, TaskTrace>();

  createTrace(params: {
    taskId: string;
    projectId: string;
    sessionId: string;
    traceId?: string;
  }): TaskTrace {
    const traceId = params.traceId ?? `trace-${randomUUID()}`;
    const trace: TaskTrace = {
      traceId,
      taskId: params.taskId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      status: "created",
      iterations: 0,
      modelCalls: [],
      totalTokensEstimate: 0,
      toolCalls: [],
      retrievals: [],
      rerankResults: [],
      recoveries: [],
      artifacts: [],
      events: [],
      startedAt: new Date().toISOString(),
    };
    this.traces.set(traceId, trace);
    return trace;
  }

  recordEvent(
    traceId: string,
    type: ObservableEventType,
    message: string,
    data?: Record<string, unknown>,
    step?: string,
  ): ObservableEvent | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;
    const sequence = trace.events.length + 1;
    const event: ObservableEvent = {
      id: `${trace.taskId}:event:${sequence}`,
      traceId,
      taskId: trace.taskId,
      projectId: trace.projectId,
      sessionId: trace.sessionId,
      sequence,
      timestamp: new Date().toISOString(),
      type,
      ...(step ? { step } : {}),
      message: redactSensitiveText(message),
      ...(data ? { data: redactObject(data) } : {}),
    };
    trace.events.push(event);
    return event;
  }

  recordModelCall(traceId: string, call: ModelCallTrace): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.modelCalls.push(call);
    trace.totalTokensEstimate +=
      call.inputTokensEstimate + call.outputTokensEstimate;
  }

  recordToolCall(traceId: string, call: ToolCallTrace): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.toolCalls.push(redactObject(call));
  }

  recordRetrieval(
    traceId: string,
    retrieval: RetrievalTrace,
    reranks: RerankRecord[] = [],
  ): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.retrievals.push(retrieval);
    trace.rerankResults.push(...reranks);
  }

  recordRecovery(traceId: string, recovery: Omit<RecoveryTrace, "timestamp">): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.recoveries.push({
      ...recovery,
      message: redactSensitiveText(recovery.message),
      timestamp: new Date().toISOString(),
    });
  }

  recordVerification(traceId: string, verification: VerificationResult): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    trace.verification = verification;
  }

  recordArtifact(traceId: string, artifact: ArtifactRecord): void {
    const trace = this.traces.get(traceId);
    if (!trace) return;
    const idx = trace.artifacts.findIndex((a) => a.path === artifact.path);
    if (idx >= 0) {
      trace.artifacts[idx] = artifact;
    } else {
      trace.artifacts.push(artifact);
    }
  }

  completeTrace(traceId: string, status: TaskStatus): TaskTrace | undefined {
    const trace = this.traces.get(traceId);
    if (!trace) return undefined;
    trace.status = status;
    trace.completedAt = new Date().toISOString();
    trace.durationMs = Math.max(
      0,
      Date.parse(trace.completedAt) - Date.parse(trace.startedAt),
    );
    return trace;
  }

  getTrace(traceId: string): TaskTrace | undefined {
    return this.traces.get(traceId);
  }

  getTraceByTaskId(taskId: string): TaskTrace | undefined {
    for (const trace of this.traces.values()) {
      if (trace.taskId === taskId) return trace;
    }
    return undefined;
  }

  listTraces(projectId?: string): TaskTrace[] {
    const all = [...this.traces.values()];
    return projectId ? all.filter((t) => t.projectId === projectId) : all;
  }
}
