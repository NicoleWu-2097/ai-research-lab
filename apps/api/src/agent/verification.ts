import { tokenizeText } from "../rag/hybrid.js";
import type {
  Claim,
  Evidence,
  TaskCategory,
  VerificationIssue,
  VerificationMode,
  VerificationResult,
} from "./types.js";

/**
 * 6.4 Determine Verification Mode based on Task Category and User Intent
 */
export function selectVerificationMode(
  category: TaskCategory,
  explicitMode?: VerificationMode,
): VerificationMode {
  if (explicitMode) return explicitMode;
  switch (category) {
    case "qa":
    case "file_operation":
    case "code_analysis":
    case "project_analysis":
    case "clarify":
      return "general";
    case "literature_discovery":
    case "report_edit":
    case "report_summarize":
      return "research";
    case "research_review":
    case "paper_analysis":
      return "strict_research";
  }
}

const CITATION_REGEX = /\[((?:RAG|WEB|PAPER|FILE|EV):[^\]]+)\]/g;

/**
 * Extract structured claims and their associated citations from a draft report or explicit claims list.
 */
export function extractClaimsFromText(text: string): Array<{
  id: string;
  text: string;
  evidenceIds: string[];
   quotes: string[];
  isStrongAssertion: boolean;
}> {
  const paragraphs = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length >= 8 &&
        !line.startsWith("#") &&
        !line.startsWith("```") &&
        !line.startsWith("说明：") &&
        !line.startsWith("【"),
    );

  return paragraphs.map((para, idx) => {
    const evidenceIds = [
      ...para.matchAll(CITATION_REGEX),
    ].map((m) => m[1]!.trim());
    const quotes = [
      ...para.matchAll(/[“"]([^”"]{4,240})[”"]/g),
    ].map((m) => m[1]!.trim());
    const isStrongAssertion =
      /已全面实现|已经完全实现|毫无疑问|绝对证明|100%|definitely proves|unquestionably|fully implemented/i.test(
        para,
      );
    return {
      id: `CLAIM:${idx + 1}`,
      text: para,
      evidenceIds,
      quotes,
      isStrongAssertion,
    };
  });
}

function checkSupportRelation(
  claimText: string,
  evidence: Evidence,
): {
  relevant: boolean;
  supports: boolean;
  contradicts: boolean;
  planPresentedAsFact: boolean;
} {
  const claimTokens = new Set(tokenizeText(claimText));
  const evTokens = new Set(
    tokenizeText(`${evidence.title ?? ""} ${evidence.originalText}`),
  );

  let overlap = 0;
  for (const t of claimTokens) {
    if (evTokens.has(t)) overlap++;
  }
  const relevant =
    claimTokens.size === 0 ? true : overlap / Math.max(1, claimTokens.size) >= 0.1 || overlap >= 1;

  // Check for direct negation / contradiction between claim and evidence
  const claimSaysImplemented =
    /已实现|已完成实现|is implemented|has been implemented/i.test(claimText) &&
    !/未实现|尚未实现|未证明实现|not implemented|planned/i.test(claimText);
  const evidenceSaysPlannedOnly =
    /planned,?\s*not implemented|仅规划|未证明实现|尚未实现|future plan/i.test(
      evidence.originalText,
    );
  const planPresentedAsFact = claimSaysImplemented && evidenceSaysPlannedOnly;

  const claimSaysPositive =
    /显著提高|总是有效|高于|优于|increases|improves|outperforms/i.test(
      claimText,
    ) && !/没有|未|不|低于|does not|fails to|no evidence/i.test(claimText);
  const evidenceSaysNegative =
    /没有显著|未发现|降低了|低于|不优于|does not improve|no significant|decreased|contradicts/i.test(
      evidence.originalText,
    );
  const contradicts =
    planPresentedAsFact || (relevant && claimSaysPositive && evidenceSaysNegative);

  return {
    relevant,
    supports: relevant && !contradicts && !planPresentedAsFact,
    contradicts,
    planPresentedAsFact,
  };
}

/**
 * 6.2 & 6.3 Verify Claims and Citations against EvidenceStore
 */
export function verifyDraftAndClaims(input: {
  draft: string;
  evidences: Evidence[];
  mode: VerificationMode;
  explicitClaims?: Array<{
    id?: string;
    text: string;
    evidenceIds: string[];
    quote?: string;
  }>;
}): VerificationResult {
  const { draft, evidences, mode } = input;

  // General mode: does not force citations, only checks that if any [RAG:...] ID is explicitly written, it isn't fabricated when evidences exist
  if (mode === "general") {
    const knownMap = new Map(evidences.map((e) => [e.id, e]));
    const citedIds = [...draft.matchAll(CITATION_REGEX)].map((m) => m[1]!.trim());
    const issues: VerificationIssue[] = [];
    for (const id of citedIds) {
      if (!knownMap.has(id)) {
        issues.push({
          evidenceId: id,
          type: "missing_source",
          message: `Citation [${id}] does not exist in the Evidence Store.`,
          recoverable: true,
          suggestedAction: "remove_citation",
        });
      }
    }
    return {
      status: issues.length === 0 ? "pass" : "partial",
      mode,
      issues,
      claims: [],
    };
  }

  const evidenceMap = new Map(evidences.map((e) => [e.id, e]));
  const extracted = input.explicitClaims
    ? input.explicitClaims.map((c, idx) => ({
        id: c.id ?? `CLAIM:${idx + 1}`,
        text: c.text,
        evidenceIds: c.evidenceIds,
        quotes: c.quote ? [c.quote] : [],
        isStrongAssertion:
          /已全面实现|毫无疑问|绝对证明|definitely proves|fully implemented/i.test(
            c.text,
          ),
      }))
    : extractClaimsFromText(draft);

  const issues: VerificationIssue[] = [];
  const verifiedClaims: Claim[] = [];

  for (const item of extracted) {
    let claimRelation: Claim["relation"] = "supporting";
    let hasValidEvidence = false;

    // 1. Check if claim in strict_research mode has no citations at all (and is not a heading/caveat)
    if (
      item.evidenceIds.length === 0 &&
      mode === "strict_research" &&
      !/待确认|局限|不确定|尚缺|未解决问题|注：|说明：|insufficient|uncertainty|limitation/i.test(
        item.text,
      )
    ) {
      issues.push({
        claimId: item.id,
        type: "unsupported_claim",
        message: `Claim "${item.text.slice(0, 80)}" lacks supporting evidence citations.`,
        recoverable: true,
        suggestedAction: "supplement_retrieval",
      });
      claimRelation = "insufficient";
    }

    for (const evId of item.evidenceIds) {
      const ev = evidenceMap.get(evId);
      // 2. Check if original source exists
      if (!ev) {
        issues.push({
          claimId: item.id,
          evidenceId: evId,
          type: "missing_source",
          message: `Claim "${item.text.slice(0, 60)}" cites non-existent Evidence ID [${evId}].`,
          recoverable: true,
          suggestedAction: "remove_citation",
        });
        if (item.isStrongAssertion) {
          issues.push({
            claimId: item.id,
            evidenceId: evId,
            type: "overstated_inference",
            message: `Claim "${item.text.slice(0, 60)}" makes an unverified strong assertion without valid evidence.`,
            recoverable: true,
            suggestedAction: "weaken_claim",
          });
        }
        claimRelation = "insufficient";
        continue;
      }

      // 3. Check if verbatim quotes are locatable in originalText
      for (const quote of item.quotes) {
        if (!ev.originalText.includes(quote)) {
          issues.push({
            claimId: item.id,
            evidenceId: evId,
            type: "unlocatable_quote",
            message: `Quote "${quote.slice(0, 50)}" cannot be located in source [${evId}].`,
            recoverable: true,
            suggestedAction: "weaken_claim",
          });
        }
      }

      // 4. Check relevance, support, contradiction, and overstated inference
      const check = checkSupportRelation(item.text, ev);
      if (!check.relevant) {
        issues.push({
          claimId: item.id,
          evidenceId: evId,
          type: "irrelevant_evidence",
          message: `Evidence [${evId}] is unrelated to claim "${item.text.slice(0, 60)}".`,
          recoverable: true,
          suggestedAction: "remove_citation",
        });
        claimRelation = "insufficient";
      } else if (check.planPresentedAsFact || item.isStrongAssertion) {
        issues.push({
          claimId: item.id,
          evidenceId: evId,
          type: "overstated_inference",
          message: `Claim "${item.text.slice(0, 60)}" overstates a planned feature or tentative finding as a proven fact.`,
          recoverable: true,
          suggestedAction: "weaken_claim",
        });
        claimRelation = "insufficient";
      } else if (check.contradicts) {
        issues.push({
          claimId: item.id,
          evidenceId: evId,
          type: "contradictory_evidence",
          message: `Evidence [${evId}] contradicts claim "${item.text.slice(0, 60)}".`,
          recoverable: true,
          suggestedAction: "present_conflicting_views",
        });
        claimRelation = "contradicting";
      } else {
        hasValidEvidence = true;
      }

      // 5. Check abstract-only paper limitation
      if (
        ev.metadata?.abstractOnly === true &&
        !/摘要|abstract/i.test(item.text) &&
        !/摘要|abstract/i.test(draft)
      ) {
        issues.push({
          claimId: item.id,
          evidenceId: evId,
          type: "abstract_only_limitation",
          message: `Paper source [${evId}] only provides an abstract; report should note this limitation.`,
          recoverable: true,
          suggestedAction: "annotate_abstract_only",
        });
      }
    }

    verifiedClaims.push({
      id: item.id,
      text: item.text,
      strength: item.isStrongAssertion
        ? "strong"
        : hasValidEvidence
          ? "moderate"
          : "tentative",
      evidenceIds: item.evidenceIds,
      relation: claimRelation,
    });
  }

  let status: VerificationResult["status"] = "pass";
  if (issues.length > 0) {
    const anyValid = verifiedClaims.some(
      (c) => c.relation === "supporting" && c.evidenceIds.length > 0,
    );
    status = anyValid || mode === "research" ? "partial" : "fail";
  }

  return {
    status,
    mode,
    issues,
    claims: verifiedClaims,
  };
}

/**
 * 6.3 Local Repair for Verification Issues
 * Repairs individual problematic citations or claims without discarding the valid parts of a report.
 */
export function repairReportLocally(
  draft: string,
  verification: VerificationResult,
  evidences: Evidence[],
): {
  repairedReport: string;
  repairedCount: number;
   supplementaryQueries: string[];
} {
  if (verification.status === "pass" || verification.issues.length === 0) {
    return {
      repairedReport: draft,
      repairedCount: 0,
      supplementaryQueries: [],
    };
  }

  const evidenceMap = new Map(evidences.map((e) => [e.id, e]));
  let repaired = draft;
  let repairedCount = 0;
  const supplementaryQueries: string[] = [];
  const notes: string[] = [];

  // 1. Remove or flag unknown / irrelevant citations
  const badEvidenceIds = new Set(
    verification.issues
      .filter(
        (i) =>
          i.type === "missing_source" || i.type === "irrelevant_evidence",
      )
      .map((i) => i.evidenceId)
      .filter((id): id is string => Boolean(id)),
  );

  if (badEvidenceIds.size > 0) {
    repaired = repaired.replace(CITATION_REGEX, (full, id: string) => {
      const trimmed = id.trim();
      if (badEvidenceIds.has(trimmed) || !evidenceMap.has(trimmed)) {
        repairedCount++;
        return "";
      }
      return full;
    });
  }

  // 2. Weaken overstated claims locally
  const hasOverstated = verification.issues.some(
    (i) => i.type === "overstated_inference",
  );
  if (hasOverstated) {
    const before = repaired;
    repaired = repaired
      .replace(/已全面实现|已经完全实现|已实现/g, "规划设计中（实际落地状态待核实）")
      .replace(/毫无疑问|绝对证明/g, "初步迹象表明")
      .replace(/definitely proves|fully implemented/gi, "suggests (pending verification)");
    if (repaired !== before) repairedCount++;
  }

  // 3. Handle contradictory evidence by presenting both perspectives
  const contradictionIssues = verification.issues.filter(
    (i) => i.type === "contradictory_evidence",
  );
  for (const issue of contradictionIssues) {
    const ev = issue.evidenceId ? evidenceMap.get(issue.evidenceId) : undefined;
    if (ev) {
      notes.push(
        `- **证据冲突说明**（关联 [${ev.id}]）：来源原文指出“${ev.originalText.slice(0, 120)}”，与部分推论存在差异，需同时参考不同研究结果。`,
      );
      repairedCount++;
    }
  }

  // 4. Annotate abstract-only sources
  const abstractIssues = verification.issues.filter(
    (i) => i.type === "abstract_only_limitation",
  );
  if (abstractIssues.length > 0) {
    const ids = [
      ...new Set(abstractIssues.map((i) => i.evidenceId).filter(Boolean)),
    ];
    notes.push(
      `- **证据范围说明**：文献 ${ids.map((id) => `[${id}]`).join("、")} 仅获取了摘要（Abstract），相关结论基于摘要内容整理，未核对全文实验细节。`,
    );
    repairedCount++;
  }

  // 5. Collect supplementary queries for unsupported claims, or annotate uncertainty
  const unsupportedIssues = verification.issues.filter(
    (i) => i.type === "unsupported_claim",
  );
  for (const issue of unsupportedIssues) {
    const claim = verification.claims?.find((c) => c.id === issue.claimId);
    if (claim) {
      supplementaryQueries.push(claim.text.slice(0, 120));
      notes.push(
        `- **待补充证据**：关于“${claim.text.slice(0, 80)}”目前证据尚不充分，作为探索性推论保留。`,
      );
      repairedCount++;
    }
  }

  // Clean up extra spaces left by removed citations
  repaired = repaired.replace(/ +([，。；,.])/g, "$1").trim();

  if (notes.length > 0) {
    repaired += `\n\n### 证据核验与局限说明\n${[...new Set(notes)].join("\n")}`;
  }

  return {
    repairedReport: repaired,
    repairedCount,
    supplementaryQueries,
  };
}
