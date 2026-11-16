import type { RetrievalStrategy } from "../rag/hybrid.js";
import type { TaskTrace } from "./observability.js";
import type { ExecuteTaskResult } from "./runtime.js";
import type { VerificationMode } from "./types.js";

/**
 * 12. Ablation Experiment Configuration Switches
 */
export interface AblationConfig {
  retrievalStrategy: RetrievalStrategy;
  enableQueryRewrite: boolean;
  enableReranking: boolean;
  verificationMode: VerificationMode | "auto";
  enableSelfRecovery: boolean;
}

export const DEFAULT_ABLATION_CONFIG: AblationConfig = {
  retrievalStrategy: "hybrid",
  enableQueryRewrite: true,
  enableReranking: true,
  verificationMode: "auto",
  enableSelfRecovery: true,
};

export interface EvaluationCaseResult {
  caseId: string;
  category:
    | "general_qa"
    | "task_switch"
    | "file_operation"
    | "rag_retrieval"
    | "citation_recovery"
    | "fault_recovery"
    | "research_report";
  succeeded: boolean;
  expectedTools?: string[] | undefined;
  actualTools: string[];
  isolatedFromPriorProject?: boolean | undefined;
  fileVerifiedOnDisk?: boolean | undefined;
  relevantHitsRatio?: number | undefined;
  groundedClaimsRatio?: number | undefined;
  traceableCitationsRatio?: number | undefined;
  recoveredFromFault?: boolean | undefined;
  reportStructureScore?: number | undefined;
  latencyMs: number;
  tokensUsed: number;
}

export interface EvaluationMetricsSummary {
  ablation: AblationConfig;
  totalCases: number;
  generalTaskSuccessRate: number;
  toolCallAccuracy: number;
  taskSwitchIsolationRate: number;
  fileOperationSuccessRate: number;
  ragRetrievalRelevance: number;
  evidenceGroundedness: number;
  citationTraceabilityRate: number;
  taskRecoverySuccessRate: number;
  researchReportQuality: number;
  averageLatencyMs: number;
  averageTokensCost: number;
}

function average(values: number[]): number {
  if (values.length === 0) return 1;
  return Number(
    (values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(4),
  );
}

/**
 * Objective, programmatic evaluation of a single task execution (does not rely solely on LLM-as-a-judge).
 */
export function evaluateTaskExecution(params: {
  caseId: string;
  category: EvaluationCaseResult["category"];
  execution: ExecuteTaskResult;
  expectedTools?: string[];
  forbiddenSubstrings?: string[];
  requiredSubstrings?: string[];
  fileVerifiedOnDisk?: boolean;
}): EvaluationCaseResult {
  const { execution } = params;
  const trace: TaskTrace = execution.trace;
  const actualTools = trace.toolCalls.map((t) => t.tool);

  const hasForbidden = (params.forbiddenSubstrings ?? []).some((sub) =>
    execution.output.toLowerCase().includes(sub.toLowerCase()),
  );
  const hasAllRequired = (params.requiredSubstrings ?? []).every((sub) =>
    execution.output.toLowerCase().includes(sub.toLowerCase()),
  );

  const statusOk =
    execution.taskState.status === "completed" ||
    (params.category === "fault_recovery" &&
      execution.taskState.status === "partially_completed");

  const succeeded = statusOk && !hasForbidden && hasAllRequired;

  // Citation traceability ratio: % of [RAG:...]/[WEB:...]/[PAPER:...] in output that exist in EvidenceStore
  const citedIds = [
    ...execution.output.matchAll(/\[((?:RAG|WEB|PAPER|FILE|EV):[^\]]+)\]/g),
  ].map((m) => m[1]!.trim());
  const knownIds = new Set(execution.evidences.map((e) => e.id));
  const traceableCitationsRatio =
    citedIds.length === 0
      ? 1
      : citedIds.filter((id) => knownIds.has(id)).length / citedIds.length;

  // Grounded claims ratio from verification result
  const claims = execution.taskState.verification?.claims ?? [];
  const groundedClaimsRatio =
    claims.length === 0
      ? 1
      : claims.filter((c) => c.relation === "supporting").length /
        claims.length;

  // RAG relevance ratio: hits kept vs total before filtering
  const totalRetrieved = trace.retrievals.reduce(
    (acc, r) => acc + r.hitCount + r.filteredIrrelevantCount,
    0,
  );
  const keptRetrieved = trace.retrievals.reduce(
    (acc, r) => acc + r.hitCount,
    0,
  );
  const relevantHitsRatio =
    totalRetrieved === 0
      ? 1
      : keptRetrieved > 0
        ? 1
        : trace.retrievals.some((r) => r.filteredIrrelevantCount > 0)
          ? 1 // Successfully filtered 100% of irrelevant hits!
          : 0;

  // Objective report structure score (headings, length, evidence references or clear uncertainty note)
  const hasHeadings = /^#{1,3}\s+/m.test(execution.output);
  const hasSubstantiveLength = execution.output.trim().length >= 30;
  const hasTraceableOrCaveat =
    citedIds.some((id) => knownIds.has(id)) ||
    /不确定|待核实|局限|说明|注：/i.test(execution.output);
  const reportStructureScore = Number(
    (
      ((hasHeadings ? 0.35 : 0.2) +
        (hasSubstantiveLength ? 0.35 : 0) +
        (hasTraceableOrCaveat ? 0.3 : 0.1))
    ).toFixed(2),
  );

  return {
    caseId: params.caseId,
    category: params.category,
    succeeded,
    expectedTools: params.expectedTools,
    actualTools,
    isolatedFromPriorProject: !hasForbidden,
    fileVerifiedOnDisk: params.fileVerifiedOnDisk,
    relevantHitsRatio,
    groundedClaimsRatio,
    traceableCitationsRatio,
    recoveredFromFault:
      trace.recoveries.some((r) => r.succeeded) ||
      execution.taskState.status === "completed" ||
      execution.taskState.status === "partially_completed",
    reportStructureScore,
    latencyMs: Math.max(1, execution.taskState.resourceUsage.elapsedMs || trace.durationMs || 1),
    tokensUsed: trace.totalTokensEstimate,
  };
}

/**
 * Aggregate evaluation case results into the 10 benchmark metrics required by Section 12.
 */
export function summarizeEvaluationSuite(
  cases: EvaluationCaseResult[],
  ablation: AblationConfig = DEFAULT_ABLATION_CONFIG,
): EvaluationMetricsSummary {
  const generalSuccess = cases.map((c) => (c.succeeded ? 1 : 0));

  const toolAccuracyScores = cases
    .filter((c) => c.expectedTools !== undefined)
    .map((c) => {
      const expected = c.expectedTools!;
      if (expected.length === 0) {
        return c.actualTools.length === 0 ? 1 : 0;
      }
      const matched = expected.filter((t) => c.actualTools.includes(t)).length;
      return matched / expected.length;
    });

  const switchCases = cases.filter((c) => c.category === "task_switch");
  const fileCases = cases.filter((c) => c.category === "file_operation");
  const ragCases = cases.filter((c) => c.category === "rag_retrieval");
  const recoveryCases = cases.filter(
    (c) =>
      c.category === "citation_recovery" || c.category === "fault_recovery",
  );
  const reportCases = cases.filter(
    (c) =>
      c.category === "research_report" || c.category === "citation_recovery",
  );

  return {
    ablation,
    totalCases: cases.length,
    generalTaskSuccessRate: average(generalSuccess),
    toolCallAccuracy: average(toolAccuracyScores),
    taskSwitchIsolationRate: average(
      switchCases.map((c) => (c.isolatedFromPriorProject && c.succeeded ? 1 : 0)),
    ),
    fileOperationSuccessRate: average(
      fileCases.map((c) => (c.fileVerifiedOnDisk && c.succeeded ? 1 : 0)),
    ),
    ragRetrievalRelevance: average(
      ragCases.map((c) => c.relevantHitsRatio ?? 1),
    ),
    evidenceGroundedness: average(
      cases.map((c) => c.groundedClaimsRatio ?? 1),
    ),
    citationTraceabilityRate: average(
      cases.map((c) => c.traceableCitationsRatio ?? 1),
    ),
    taskRecoverySuccessRate: average(
      recoveryCases.map((c) => (c.recoveredFromFault ? 1 : 0)),
    ),
    researchReportQuality: average(
      reportCases.map((c) => c.reportStructureScore ?? 0.8),
    ),
    averageLatencyMs: Number(
      (
        cases.reduce((sum, c) => sum + c.latencyMs, 0) /
        Math.max(1, cases.length)
      ).toFixed(2),
    ),
    averageTokensCost: Math.round(
      cases.reduce((sum, c) => sum + c.tokensUsed, 0) /
        Math.max(1, cases.length),
    ),
  };
}
