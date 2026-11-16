import { randomUUID } from "node:crypto";
import { tokenizeText } from "../rag/hybrid.js";
import type {
  ArtifactRecord,
  Evidence,
  FailureCategory,
  TaskCategory,
  TaskState,
  VerificationMode,
} from "./types.js";

export interface ConversationTurn {
  id: string;
  sessionId: string;
  projectId: string;
  taskId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type ContinuityAction =
  | "new_task"
  | "continue_task"
  | "save_report"
  | "edit_section"
  | "supplement_citations"
  | "fresh_retrieval"
  | "switch_project";

export interface ActiveUserRequest {
  id: string;
  projectId: string;
  sessionId: string;
  taskId: string;
  rawMessage: string;
  resolvedGoal: string;
  category: TaskCategory;
  continuity: ContinuityAction;
  targetSection?: string;
  targetFilePath?: string;
  discardPriorRetrieval: boolean;
  crossProjectReference?: string;
  verificationMode: VerificationMode;
}

export interface ProjectContext {
  projectId: string;
  name: string;
  description: string;
  workspaceRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMemory {
  projectId: string;
  summary: string;
  workspaceRoot: string;
  indexedDocumentIds: string[];
  userConstraints: string[];
  researchSummaries: Array<{
    taskId: string;
    goal: string;
    conclusionPreview: string;
    updatedAt: string;
  }>;
  activeReport: {
    taskId: string;
    content: string;
    sections: Record<string, string>;
    evidenceIds: string[];
    revision: number;
    updatedAt: string;
  } | null;
  artifacts: ArtifactRecord[];
}

export interface TaskCheckpoint {
  stepIndex: number;
  currentStep: string;
  completedSteps: string[];
  pendingSteps: string[];
  draft: string;
  evidenceIds: string[];
  savedAt: string;
}

export interface TaskMemory {
  taskId: string;
  projectId: string;
  goal: string;
  completedSteps: string[];
  pendingSteps: string[];
  failureRecords: Array<{
    step: string;
    category: FailureCategory;
    message: string;
    recovered: boolean;
    timestamp: string;
  }>;
  verifiedEvidenceIds: string[];
  intermediateDraft: string;
  checkpoint: TaskCheckpoint | null;
}

export interface RetrievedContext {
  taskId: string;
  projectId: string;
  queries: string[];
  evidences: Evidence[];
}

export interface AgentWorkingMemory {
  taskId: string;
  projectId: string;
  plan: string[];
  notes: string[];
  toolOutputs: Array<{
    tool: string;
    summary: string;
    timestamp: string;
  }>;
}

export interface CompactedContextSnapshot {
  projectId: string;
  projectSummary: string;
  originalGoal: string;
  constraints: string[];
  recentConversationSummary: string;
  activeReportPreview: string;
  evidenceIndex: Array<{
    id: string;
    sourceType: string;
    titleOrSource: string;
    snippet: string;
  }>;
  artifactPaths: string[];
  completedSteps: string[];
  pendingSteps: string[];
  recentToolResults: string[];
  compacted: boolean;
  estimatedBytes: number;
}

/**
 * Parse a Markdown report into named sections so partial section edits ("只修改报告中的结论部分")
 * modify only the requested section without losing or duplicating the rest of the report.
 */
export function parseMarkdownSections(markdown: string): {
  preamble: string;
  sections: Array<{ heading: string; level: number; rawHeading: string; body: string }>;
} {
  const lines = markdown.split("\n");
  let preamble = "";
  const sections: Array<{
    heading: string;
    level: number;
    rawHeading: string;
    body: string;
  }> = [];

  let current: {
    heading: string;
    level: number;
    rawHeading: string;
    bodyLines: string[];
  } | null = null;

  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      if (current) {
        sections.push({
          heading: current.heading,
          level: current.level,
          rawHeading: current.rawHeading,
          body: current.bodyLines.join("\n").trim(),
        });
      }
      current = {
        heading: match[2]!.trim(),
        level: match[1]!.length,
        rawHeading: line,
        bodyLines: [],
      };
    } else if (current) {
      current.bodyLines.push(line);
    } else {
      preamble += (preamble ? "\n" : "") + line;
    }
  }

  if (current) {
    sections.push({
      heading: current.heading,
      level: current.level,
      rawHeading: current.rawHeading,
      body: current.bodyLines.join("\n").trim(),
    });
  }

  return { preamble: preamble.trim(), sections };
}

export function replaceMarkdownSection(
  markdown: string,
  sectionTarget: string,
  newBody: string,
): string {
  const parsed = parseMarkdownSections(markdown);
  if (parsed.sections.length === 0) {
    return `${markdown.trim()}\n\n## ${sectionTarget}\n${newBody.trim()}`;
  }

  const normalizedTarget = sectionTarget
    .replace(/部分|章节|一节|section/gi, "")
    .trim()
    .toLowerCase();

  let matched = false;
  const updatedSections = parsed.sections.map((sec) => {
    const normHeading = sec.heading.toLowerCase();
    if (
      !matched &&
      (normHeading.includes(normalizedTarget) ||
        normalizedTarget.includes(normHeading))
    ) {
      matched = true;
      // Strip duplicate heading if newBody already starts with a markdown heading
      const cleanedBody = newBody
        .trim()
        .replace(/^#{1,4}\s+[^\n]+\n+/, "")
        .trim();
      return {
        ...sec,
        body: cleanedBody,
      };
    }
    return sec;
  });

  if (!matched) {
    updatedSections.push({
      heading: sectionTarget,
      level: 2,
      rawHeading: `## ${sectionTarget}`,
      body: newBody.trim(),
    });
  }

  const parts: string[] = [];
  if (parsed.preamble) parts.push(parsed.preamble);
  for (const sec of updatedSections) {
    parts.push(`${sec.rawHeading}\n${sec.body}`);
  }
  return parts.join("\n\n");
}

/**
 * 3.1 & 3.2 Understand Request & Determine Task Continuity vs New Task
 */
export function analyzeUserRequest(input: {
  message: string;
  projectId: string;
  previousProjectId?: string | undefined;
  sessionId: string;
  projectMemory: ProjectMemory;
  recentTurns: ConversationTurn[];
  explicitVerificationMode?: VerificationMode | undefined;
}): ActiveUserRequest {
  const raw = input.message.trim();
  const projectSwitched =
    Boolean(input.previousProjectId) &&
    input.previousProjectId !== input.projectId;
  const hasActiveReport = Boolean(
    input.projectMemory.activeReport?.content.trim(),
  );

  // 1. Check for explicit project switch command
  if (/^(切换项目|switch project)/i.test(raw)) {
    return {
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: randomUUID(),
      rawMessage: raw,
      resolvedGoal: raw,
      category: "project_analysis",
      continuity: "switch_project",
      discardPriorRetrieval: true,
      verificationMode: input.explicitVerificationMode ?? "general",
    };
  }

  // 2. Check for file save / export request ("把刚才的报告保存成 Markdown", "把报告保存到当前目录", "写入 md 文档")
  const isSaveRequest =
    /(保存|写入|导出|存成|存为|save|write|export).*(报告|文档|文件|markdown|\.md|当前目录|目录)/i.test(
      raw,
    ) ||
    /(把.*报告|把刚才的).*(保存|写入|导出)/i.test(raw);

  if (isSaveRequest) {
    const fileMatch = raw.match(
      /([a-zA-Z0-9._/-]+\.(?:md|txt|json|ts|js))/,
    );
    const targetFilePath = fileMatch?.[1] ?? "report.md";
    return {
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: input.projectMemory.activeReport?.taskId ?? randomUUID(),
      rawMessage: raw,
      resolvedGoal: raw,
      category: "file_operation",
      continuity: hasActiveReport ? "save_report" : "new_task",
      targetFilePath,
      discardPriorRetrieval: false,
      verificationMode: input.explicitVerificationMode ?? "general",
    };
  }

  // 3. Check for fresh retrieval instruction ("重新检索，不要复用之前的结果")
  const isFreshRetrieval =
    /重新检索|不要复用|不复用之前|重新搜索|re-retrieve|do not reuse/i.test(raw);
  if (isFreshRetrieval) {
    const lastGoal =
      input.projectMemory.researchSummaries.at(-1)?.goal ??
      input.recentTurns.filter((t) => t.role === "user").at(-1)?.content ??
      raw;
    return {
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: randomUUID(),
      rawMessage: raw,
      resolvedGoal:
        raw.replace(/重新检索[，,。]?\s*不要复用之前的结果[，,。]?/g, "").trim() ||
        lastGoal,
      category: "research_review",
      continuity: "fresh_retrieval",
      discardPriorRetrieval: true,
      verificationMode: input.explicitVerificationMode ?? "research",
    };
  }

  // 4. Check for partial section edit ("只修改报告中的结论部分", "修改其中一节")
  const sectionEditMatch =
    raw.match(
      /(?:只?修改|重写|改写|更新|调整)(?:刚才的|已有)?(?:报告(?:中的|里的|的)?)?([^\n，,。：:]{1,20}?)(?:部分|一节|章节)/i,
    ) ??
    raw.match(/(?:只?修改|重写|改写)其中(?:的)?([^\n，,。：:]{1,20})/i);

  if (
    hasActiveReport &&
    !projectSwitched &&
    (sectionEditMatch || /^(修改|改写|缩成|改成表格|总结一下)/i.test(raw))
  ) {
    const isSummarize = /^总结/i.test(raw);
    const targetSection = sectionEditMatch?.[1]?.trim() || "结论";
    return {
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: input.projectMemory.activeReport!.taskId,
      rawMessage: raw,
      resolvedGoal: raw,
      category: isSummarize ? "report_summarize" : "report_edit",
      continuity: "edit_section",
      targetSection,
      discardPriorRetrieval: false,
      verificationMode: input.explicitVerificationMode ?? "research",
    };
  }

  // 5. Check for supplementing citations or continuing investigation ("继续刚才的调研", "继续补充引用")
  const isSupplementCitations =
    hasActiveReport &&
    !projectSwitched &&
    /补充引用|增加引用|添加引文|补充证据|add citations|supplement citations/i.test(
      raw,
    );
  if (isSupplementCitations) {
    return {
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: input.projectMemory.activeReport!.taskId,
      rawMessage: raw,
      resolvedGoal: raw,
      category: "research_review",
      continuity: "supplement_citations",
      discardPriorRetrieval: false,
      verificationMode: input.explicitVerificationMode ?? "strict_research",
    };
  }

  const isContinueResearch =
    !projectSwitched &&
    /^(继续刚才的|继续调研|继续研究|深入调研|接着刚才|continue)/i.test(raw);
  if (isContinueResearch) {
    const priorGoal =
      input.projectMemory.researchSummaries.at(-1)?.goal ??
      input.recentTurns.filter((t) => t.role === "user").at(-1)?.content ??
      raw;
    return {
      id: randomUUID(),
      projectId: input.projectId,
      sessionId: input.sessionId,
      taskId: input.projectMemory.activeReport?.taskId ?? randomUUID(),
      rawMessage: raw,
      resolvedGoal: `${priorGoal}（${raw}）`,
      category: "research_review",
      continuity: "continue_task",
      discardPriorRetrieval: false,
      verificationMode: input.explicitVerificationMode ?? "research",
    };
  }

  // 6. Classify new request category
  const isUxOrProjectQuestion =
    /\b(atlas|ux|ui|用户体验|界面|前端|组件|代码|重构|架构改进|改进点|CLI)\b/i.test(
      raw,
    ) && !/文献综述|学术论文|paper|arxiv|doi/i.test(raw);

  const isGeneralConceptExplanation =
    /(?:^|\b)(解释|什么是|介绍一下|如何理解|讲讲|说明一下|explain|what is|how does)\s*/i.test(
      raw,
    ) &&
    /\b(react|fiber|typescript|javascript|python|docker|git|http|tcp|algorithm|闭包|协程|虚拟DOM|线程)\b/i.test(
      raw,
    );

  const isLiteratureSearch =
    /搜索论文|查找论文|文献发现|检索.*论文|近三年|最新论文|arxiv|openalex|crossref|semantic scholar|literature/i.test(
      raw,
    );

  const isPaperAnalysis =
    /解析论文|阅读论文|提取章节|pdf|doi\s*[:：]|10\.\d{4}/i.test(raw);

  let category: TaskCategory = "research_review";
  if (isGeneralConceptExplanation) {
    category = "qa";
  } else if (isUxOrProjectQuestion) {
    category = "project_analysis";
  } else if (isLiteratureSearch) {
    category = "literature_discovery";
  } else if (isPaperAnalysis) {
    category = "paper_analysis";
  }

  // Check topic similarity with previous turn in the SAME project
  let continuity: ContinuityAction = "new_task";
  if (!projectSwitched && hasActiveReport && input.recentTurns.length > 0) {
    const lastUserTurn = input.recentTurns
      .filter((t) => t.role === "user")
      .at(-1);
    if (lastUserTurn) {
      const prevTokens = new Set(tokenizeText(lastUserTurn.content));
      const currTokens = tokenizeText(raw);
      const overlap = currTokens.filter((t) => prevTokens.has(t)).length;
      const hasAnaphora = /刚才|上面|该报告|这份|其中|它|这个/i.test(raw);
      if (hasAnaphora && overlap >= 1) {
        continuity = "continue_task";
      }
    }
  }

  const verificationMode =
    input.explicitVerificationMode ??
    (category === "qa" || category === "project_analysis"
      ? "general"
      : category === "literature_discovery"
        ? "research"
        : "strict_research");

  return {
    id: randomUUID(),
    projectId: input.projectId,
    sessionId: input.sessionId,
    taskId: randomUUID(),
    rawMessage: raw,
    resolvedGoal: raw,
    category,
    continuity,
    discardPriorRetrieval: continuity === "new_task" || projectSwitched,
    verificationMode,
  };
}

/**
 * 8.4 Context Compaction
 * Compresses long history when approaching context byte/token limits while preserving
 * user goal, project identity, constraints, Evidence IDs, artifact paths, and pending work.
 */
export function compactContext(input: {
  projectMemory: ProjectMemory;
  taskState: TaskState;
  conversation: ConversationTurn[];
  evidences: Evidence[];
  workingMemory: AgentWorkingMemory;
  maxContextBytes?: number;
}): CompactedContextSnapshot {
  const maxBytes = input.maxContextBytes ?? 16_000;

  // Scope conversation strictly to current projectId
  const projectTurns = input.conversation.filter(
    (t) => t.projectId === input.projectMemory.projectId,
  );

  // Scope evidence strictly to current taskId or active project report
  const scopedEvidences = input.evidences.filter(
    (e) =>
      e.taskId === input.taskState.taskId &&
      (!e.projectId || e.projectId === input.projectMemory.projectId),
  );

  const rawHistoryText = projectTurns
    .map((t) => `${t.role}: ${t.content}`)
    .join("\n");
  const rawEvidenceText = scopedEvidences
    .map((e) => `[${e.id}] ${e.originalText}`)
    .join("\n");
  const totalRawBytes =
    Buffer.byteLength(rawHistoryText) + Buffer.byteLength(rawEvidenceText);

  const needsCompaction = totalRawBytes > maxBytes;

  const recentTurns = needsCompaction
    ? projectTurns.slice(-4)
    : projectTurns.slice(-8);
  const recentConversationSummary = recentTurns
    .map((t) => {
      const limit = needsCompaction ? 300 : 800;
      const body =
        t.content.length > limit
          ? `${t.content.slice(0, limit)}... [compacted]`
          : t.content;
      return `${t.role}: ${body}`;
    })
    .join("\n");

  const snippetLimit = needsCompaction ? 240 : 600;
  const evidenceIndex = scopedEvidences.slice(0, 12).map((e) => ({
    id: e.id,
    sourceType: e.sourceType,
    titleOrSource: e.title ?? e.documentId ?? e.sourceId,
    snippet:
      e.originalText.length > snippetLimit
        ? `${e.originalText.slice(0, snippetLimit)}...`
        : e.originalText,
  }));

  const activeReportContent = input.projectMemory.activeReport?.content ?? "";
  const activeReportPreview =
    activeReportContent.length > (needsCompaction ? 1200 : 4000)
      ? `${activeReportContent.slice(0, needsCompaction ? 1200 : 4000)}... [compacted]`
      : activeReportContent;

  const snapshot: CompactedContextSnapshot = {
    projectId: input.projectMemory.projectId,
    projectSummary: input.projectMemory.summary,
    originalGoal: input.taskState.goal,
    constraints: input.projectMemory.userConstraints,
    recentConversationSummary,
    activeReportPreview,
    evidenceIndex,
    artifactPaths: input.projectMemory.artifacts.map((a) => a.path),
    completedSteps: input.taskState.completedSteps,
    pendingSteps: input.taskState.pendingSteps,
    recentToolResults: input.workingMemory.toolOutputs
      .slice(-5)
      .map((o) => `${o.tool}: ${o.summary.slice(0, 250)}`),
    compacted: needsCompaction,
    estimatedBytes: 0,
  };

  snapshot.estimatedBytes = Buffer.byteLength(JSON.stringify(snapshot));
  return snapshot;
}

/**
 * Project & Session Context Manager
 * Maintains strict isolation between projects while supporting multi-turn continuity within a project.
 */
export class ContextManager {
  private readonly projects = new Map<string, ProjectContext>();
  private readonly projectMemories = new Map<string, ProjectMemory>();
  private readonly taskMemories = new Map<string, TaskMemory>();
  private readonly workingMemories = new Map<string, AgentWorkingMemory>();
  private readonly retrievedContexts = new Map<string, RetrievedContext>();
  private readonly conversationTurns: ConversationTurn[] = [];
  private activeProjectId = "default";

  ensureProject(
    projectId: string,
    options: {
      name?: string | undefined;
      description?: string | undefined;
      workspaceRoot?: string | undefined;
    } = {},
  ): { context: ProjectContext; memory: ProjectMemory } {
    const now = new Date().toISOString();
    let context = this.projects.get(projectId);
    if (!context) {
      context = {
        projectId,
        name: options.name ?? projectId,
        description: options.description ?? `Project ${projectId}`,
        workspaceRoot: options.workspaceRoot ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      this.projects.set(projectId, context);
    } else if (options.workspaceRoot) {
      context.workspaceRoot = options.workspaceRoot;
      context.updatedAt = now;
    }

    let memory = this.projectMemories.get(projectId);
    if (!memory) {
      memory = {
        projectId,
        summary: context.description,
        workspaceRoot: context.workspaceRoot,
        indexedDocumentIds: [],
        userConstraints: [],
        researchSummaries: [],
        activeReport: null,
        artifacts: [],
      };
      this.projectMemories.set(projectId, memory);
    }
    return { context, memory };
  }

  switchProject(
    projectId: string,
    options: {
      name?: string | undefined;
      description?: string | undefined;
      workspaceRoot?: string | undefined;
    } = {},
  ): ProjectContext {
    const { context } = this.ensureProject(projectId, options);
    this.activeProjectId = projectId;
    return context;
  }

  getActiveProjectId(): string {
    return this.activeProjectId;
  }

  getProjectMemory(projectId: string): ProjectMemory {
    return this.ensureProject(projectId).memory;
  }

  listProjects(): ProjectContext[] {
    return [...this.projects.values()];
  }

  deleteProject(projectId: string): boolean {
    const existed = this.projects.delete(projectId);
    this.projectMemories.delete(projectId);
    if (this.activeProjectId === projectId) {
      this.activeProjectId = "default";
    }
    return existed;
  }

  recordTurn(turn: Omit<ConversationTurn, "id" | "createdAt">): ConversationTurn {
    const full: ConversationTurn = {
      ...turn,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.conversationTurns.push(full);
    return full;
  }

  getProjectTurns(projectId: string): ConversationTurn[] {
    return this.conversationTurns.filter((t) => t.projectId === projectId);
  }

  initTaskMemory(taskId: string, projectId: string, goal: string): TaskMemory {
    const mem: TaskMemory = {
      taskId,
      projectId,
      goal,
      completedSteps: [],
      pendingSteps: [],
      failureRecords: [],
      verifiedEvidenceIds: [],
      intermediateDraft: "",
      checkpoint: null,
    };
    this.taskMemories.set(taskId, mem);
    this.workingMemories.set(taskId, {
      taskId,
      projectId,
      plan: [],
      notes: [],
      toolOutputs: [],
    });
    this.retrievedContexts.set(taskId, {
      taskId,
      projectId,
      queries: [],
      evidences: [],
    });
    return mem;
  }

  getTaskMemory(taskId: string): TaskMemory | undefined {
    return this.taskMemories.get(taskId);
  }

  getWorkingMemory(taskId: string): AgentWorkingMemory {
    let wm = this.workingMemories.get(taskId);
    if (!wm) {
      wm = {
        taskId,
        projectId: this.activeProjectId,
        plan: [],
        notes: [],
        toolOutputs: [],
      };
      this.workingMemories.set(taskId, wm);
    }
    return wm;
  }

  getRetrievedContext(taskId: string, projectId: string): RetrievedContext {
    let rc = this.retrievedContexts.get(taskId);
    if (!rc || rc.projectId !== projectId) {
      rc = { taskId, projectId, queries: [], evidences: [] };
      this.retrievedContexts.set(taskId, rc);
    }
    return rc;
  }

  saveReportToProject(
    projectId: string,
    taskId: string,
    report: string,
    evidenceIds: string[],
  ): void {
    const { memory } = this.ensureProject(projectId);
    const parsed = parseMarkdownSections(report);
    const sectionsMap: Record<string, string> = {};
    for (const sec of parsed.sections) {
      sectionsMap[sec.heading] = sec.body;
    }
    const prevRevision = memory.activeReport?.revision ?? 0;
    memory.activeReport = {
      taskId,
      content: report,
      sections: sectionsMap,
      evidenceIds,
      revision: prevRevision + 1,
      updatedAt: new Date().toISOString(),
    };
  }

  recordArtifact(artifact: ArtifactRecord): void {
    const { memory } = this.ensureProject(artifact.projectId);
    const existingIdx = memory.artifacts.findIndex(
      (a) => a.path === artifact.path,
    );
    if (existingIdx >= 0) {
      memory.artifacts[existingIdx] = artifact;
    } else {
      memory.artifacts.push(artifact);
    }
  }
}
