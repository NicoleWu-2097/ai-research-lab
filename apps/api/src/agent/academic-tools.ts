import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { RagService } from "../rag/service.js";
import type { EvidenceStore } from "./evidence.js";
import type { ToolRegistry } from "./tools.js";
import { resolveWorkspacePath } from "./workspace-tools.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "./types.js";

export type AcademicSourceProvider =
  | "openalex"
  | "crossref"
  | "semantic_scholar"
  | "arxiv"
  | "web";

export type PublicationType = "preprint" | "peer_reviewed" | "other";

export interface AcademicPaperMetadata {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  url: string;
  abstract: string;
  abstractOnly: boolean;
  venue?: string | undefined;
  publicationType: PublicationType;
  sourceProvider: AcademicSourceProvider;
  retrievedAt: string;
}

export interface ParsedPaperSection {
  heading: string;
  content: string;
  page?: number;
  startOffset: number;
  endOffset: number;
}

export interface ParsedPaperStructure {
  title: string;
  authors: string[];
  year: number | null;
  doi: string | null;
  abstract: string;
  sections: ParsedPaperSection[];
  tables: Array<{
    caption: string;
    markdown: string;
    crossPage: boolean;
    page?: number;
    startOffset: number;
  }>;
  formulas: Array<{
    latex: string;
    page?: number;
    startOffset: number;
  }>;
  figureCaptions: Array<{
    figureNumber: string;
    caption: string;
    page?: number;
  }>;
  footnotes: string[];
  references: string[];
  unparsedRegions: Array<{
    reason: "two_column_interleave" | "corrupted_glyphs" | "complex_table" | "missing_section";
    description: string;
    page?: number;
    startOffset: number;
    endOffset: number;
  }>;
  structuredMarkdown: string;
}

export type ResearchWorkflowType =
  | "Literature Discovery"
  | "Literature Review"
  | "Paper Comparison"
  | "Research Gap Analysis"
  | "Evidence Synthesis"
  | "Academic Writing"
  | "Citation Verification"
  | "Research Note Generation";

function normalizePaperTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "")
    .trim();
}

function normalizeDoi(doi?: string | null): string | null {
  if (!doi) return null;
  return doi
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
}

/**
 * Deduplicate papers across providers by DOI, normalized title, or ID.
 */
export function deduplicatePapers(
  papers: AcademicPaperMetadata[],
): AcademicPaperMetadata[] {
  const byDoi = new Map<string, AcademicPaperMetadata>();
  const byTitle = new Map<string, AcademicPaperMetadata>();
  const result: AcademicPaperMetadata[] = [];

  for (const paper of papers) {
    const doi = normalizeDoi(paper.doi);
    const normTitle = normalizePaperTitle(paper.title);

    const existing =
      (doi ? byDoi.get(doi) : undefined) ??
      (normTitle ? byTitle.get(normTitle) : undefined);

    if (existing) {
      // Merge richer metadata (e.g. if second source has abstract or DOI that first lacked)
      if (!existing.abstract && paper.abstract) {
        existing.abstract = paper.abstract;
      }
      if (!existing.doi && doi) {
        existing.doi = doi;
        byDoi.set(doi, existing);
      }
      if (
        existing.publicationType !== "peer_reviewed" &&
        paper.publicationType === "peer_reviewed"
      ) {
        existing.publicationType = "peer_reviewed";
      }
      continue;
    }

    const normalizedPaper: AcademicPaperMetadata = {
      ...paper,
      doi,
    };
    if (doi) byDoi.set(doi, normalizedPaper);
    if (normTitle) byTitle.set(normTitle, normalizedPaper);
    result.push(normalizedPaper);
  }

  return result;
}

/**
 * Reconstruct OpenAlex inverted-index abstract into plain text
 */
function reconstructOpenAlexAbstract(
  inverted?: Record<string, number[]> | null,
): string {
  if (!inverted || typeof inverted !== "object") return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inverted)) {
    if (Array.isArray(positions)) {
      for (const pos of positions) {
        words[pos] = word;
      }
    }
  }
  return words.filter(Boolean).join(" ");
}

/**
 * 5.2 Structured Paper Parser
 * Handles Markdown/text/PDF-extracted text, including two-column detection,
 * formulas, tables, figure captions, footnotes, references, and locator preservation.
 */
export function parseAcademicPaperText(
  rawText: string,
  metadataOverride?: {
    title?: string | undefined;
    authors?: string[] | undefined;
    year?: number | undefined;
    doi?: string | undefined;
  },
): ParsedPaperStructure {
  const text = rawText.replace(/\r\n/g, "\n");
  const unparsedRegions: ParsedPaperStructure["unparsedRegions"] = [];

  // Detect page markers like [Page 1] or \f
  const getPageAtOffset = (offset: number): number => {
    const prefix = text.slice(0, offset);
    const formFeeds = (prefix.match(/\f/g) ?? []).length;
    const explicitPages = [
      ...prefix.matchAll(/\[Page\s*(\d+)\]|<!--\s*page:\s*(\d+)\s*-->/gi),
    ];
    if (explicitPages.length > 0) {
      const last = explicitPages.at(-1)!;
      return Number(last[1] ?? last[2] ?? 1);
    }
    return formFeeds + 1;
  };

  // Detect two-column interleaving artifacts (lines with wide internal whitespace gaps mid-sentence)
  const twoColRegex = /[^\n]+\s{6,}[^\n]+\n[^\n]+\s{6,}[^\n]+/g;
  for (const match of text.matchAll(twoColRegex)) {
    const startOffset = match.index ?? 0;
    const endOffset = startOffset + match[0].length;
    unparsedRegions.push({
      reason: "two_column_interleave",
      description:
        "Detected potential two-column layout text interleaving; verify against original PDF page.",
      page: getPageAtOffset(startOffset),
      startOffset,
      endOffset,
    });
  }

  // Detect corrupted PDF glyph regions (e.g., replacement characters)
  const corruptedRegex = /\uFFFD{2,}/g;
  for (const match of text.matchAll(corruptedRegex)) {
    const startOffset = match.index ?? 0;
    unparsedRegions.push({
      reason: "corrupted_glyphs",
      description: "Unreadable PDF font encoding / corrupted glyphs.",
      page: getPageAtOffset(startOffset),
      startOffset,
      endOffset: startOffset + match[0].length,
    });
  }

  // Extract metadata
  const doiMatch = text.match(/\b(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/);
  const doi = normalizeDoi(metadataOverride?.doi ?? doiMatch?.[1] ?? null);

  const yearMatch = text.match(/\b(19\d{2}|20[0-2]\d)\b/);
  const year =
    metadataOverride?.year ?? (yearMatch ? Number(yearMatch[1]) : null);

  const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const firstNonEmptyLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 4 && !l.startsWith("[Page"));
  const title =
    metadataOverride?.title ??
    firstHeading ??
    firstNonEmptyLine ??
    "Untitled Paper";

  const authorLineMatch = text.match(
    /(?:Authors?|作者)\s*[:：]\s*([^\n]+)/i,
  );
  const authors =
    metadataOverride?.authors ??
    (authorLineMatch?.[1]
      ? authorLineMatch[1]
          .split(/[,，;；]|and/i)
          .map((a) => a.trim())
          .filter(Boolean)
      : []);

  // Extract abstract
  const abstractMatch = text.match(
    /(?:^|\n)(?:#+\s*)?(?:Abstract|摘要)\s*[:：\n]\s*([\s\S]*?)(?=\n(?:#+\s+|\d+\.?\s+(?:Introduction|引言|背景)|Keywords|关键词|\n\n#)|\n$)/i,
  );
  const abstract = abstractMatch?.[1]?.trim() ?? "";

  // Extract sections
  const sectionRegex =
    /(?:^|\n)(#{1,3}\s+[^\n]+|\d+(?:\.\d+)*\s+[A-Z\u4e00-\u9fff][^\n]{1,80})\n/g;
  const headingMatches = [...text.matchAll(sectionRegex)];
  const sections: ParsedPaperSection[] = [];

  if (headingMatches.length === 0) {
    sections.push({
      heading: "Body",
      content: text.trim(),
      page: 1,
      startOffset: 0,
      endOffset: text.length,
    });
  } else {
    for (let i = 0; i < headingMatches.length; i++) {
      const current = headingMatches[i]!;
      const next = headingMatches[i + 1];
      const heading = current[1]!.replace(/^#+\s*/, "").trim();
      const startOffset = current.index ?? 0;
      const bodyStart = startOffset + current[0].length;
      const endOffset = next?.index ?? text.length;
      const content = text.slice(bodyStart, endOffset).trim();
      sections.push({
        heading,
        content,
        page: getPageAtOffset(startOffset),
        startOffset,
        endOffset,
      });
    }
  }

  // Extract formulas ($$...$$, \begin{equation}...\end{equation}, inline $...$)
  const formulas: ParsedPaperStructure["formulas"] = [];
  const formulaRegex =
    /(\$\$[\s\S]+?\$\$|\\begin\{equation\*?\}[\s\S]+?\\end\{equation\*?\}|\$[^$\n]{3,120}\$)/g;
  for (const match of text.matchAll(formulaRegex)) {
    const startOffset = match.index ?? 0;
    formulas.push({
      latex: match[1]!.trim(),
      page: getPageAtOffset(startOffset),
      startOffset,
    });
  }

  // Extract tables (Markdown pipe tables and Table N captions, including cross-page continuations)
  const tables: ParsedPaperStructure["tables"] = [];
  const tableRegex =
    /(?:(Table\s+\d+[^\n]*|表\s*\d+[^\n]*)\n)?((?:\|[^\n]+\|\n)+)/gi;
  for (const match of text.matchAll(tableRegex)) {
    const startOffset = match.index ?? 0;
    const caption = (match[1] ?? "Table").trim();
    const markdown = match[2]!.trim();
    const crossPage =
      /continued|续表/i.test(caption) || /\[Page\s*\d+\]|\f/.test(markdown);
    if (crossPage) {
      unparsedRegions.push({
        reason: "complex_table",
        description: `Cross-page table detected ("${caption}"); check original PDF page boundaries.`,
        page: getPageAtOffset(startOffset),
        startOffset,
        endOffset: startOffset + match[0].length,
      });
    }
    tables.push({
      caption,
      markdown,
      crossPage,
      page: getPageAtOffset(startOffset),
      startOffset,
    });
  }

  // Extract figure captions
  const figureCaptions: ParsedPaperStructure["figureCaptions"] = [];
  const figRegex =
    /(?:^|\n)((?:Figure|Fig\.|图)\s*(\d+[a-zA-Z]?)\s*[:：.]\s*([^\n]+))/gi;
  for (const match of text.matchAll(figRegex)) {
    const startOffset = match.index ?? 0;
    figureCaptions.push({
      figureNumber: match[2]!,
      caption: match[3]!.trim(),
      page: getPageAtOffset(startOffset),
    });
  }

  // Extract footnotes
  const footnotes: string[] = [];
  const footnoteRegex = /(?:^|\n)(\[\^\d+\]:\s*[^\n]+|Footnote\s*\d+:\s*[^\n]+)/gi;
  for (const match of text.matchAll(footnoteRegex)) {
    footnotes.push(match[1]!.trim());
  }

  // Extract references section items
  const references: string[] = [];
  const refSection = sections.find((s) =>
    /^(references|bibliography|参考文献)$/i.test(s.heading),
  );
  if (refSection) {
    const lines = refSection.content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 10);
    references.push(...lines.slice(0, 50));
  }

  // Build structured Markdown summary
  const structuredMarkdown = [
    `# ${title}`,
    ...(authors.length ? [`**Authors**: ${authors.join(", ")}`] : []),
    ...(year ? [`**Year**: ${year}`] : []),
    ...(doi ? [`**DOI**: ${doi}`] : []),
    ...(abstract ? [`## Abstract\n${abstract}`] : []),
    ...sections.map(
      (s) =>
        `## ${s.heading}${s.page ? ` (Page ${s.page})` : ""}\n${s.content}`,
    ),
    ...(tables.length
      ? [
          `## Extracted Tables (${tables.length})\n` +
            tables
              .map(
                (t) =>
                  `### ${t.caption}${t.crossPage ? " [Cross-Page]" : ""}\n${t.markdown}`,
              )
              .join("\n\n"),
        ]
      : []),
    ...(formulas.length
      ? [
          `## Extracted Formulas (${formulas.length})\n` +
            formulas.map((f) => `- Page ${f.page ?? 1}: \`${f.latex}\``).join("\n"),
        ]
      : []),
    ...(figureCaptions.length
      ? [
          `## Figure Captions (${figureCaptions.length})\n` +
            figureCaptions
              .map((f) => `- **Figure ${f.figureNumber}** (Page ${f.page ?? 1}): ${f.caption}`)
              .join("\n"),
        ]
      : []),
    ...(unparsedRegions.length
      ? [
          `## PDF Parsing Locator Warnings\n` +
            unparsedRegions
              .map(
                (u) =>
                  `- [${u.reason}] Page ${u.page ?? 1} (offsets ${u.startOffset}–${u.endOffset}): ${u.description}`,
              )
              .join("\n"),
        ]
      : []),
  ].join("\n\n");

  return {
    title,
    authors,
    year,
    doi,
    abstract,
    sections,
    tables,
    formulas,
    figureCaptions,
    footnotes,
    references,
    unparsedRegions,
    structuredMarkdown,
  };
}

export interface AcademicToolsOptions {
  fetchImpl?: typeof fetch | undefined;
  rag?: RagService | null | undefined;
  evidenceStore?: EvidenceStore | undefined;
}

export class LiteratureDiscoveryService {
  private readonly cache = new Map<
    string,
    { timestamp: number; papers: AcademicPaperMetadata[] }
  >();
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async search(input: {
    query: string;
    author?: string;
    yearFrom?: number;
    yearTo?: number;
    sources?: AcademicSourceProvider[];
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{
    papers: AcademicPaperMetadata[];
    providersQueried: AcademicSourceProvider[];
    providerErrors: Record<string, string>;
  }> {
    const cacheKey = JSON.stringify({
      q: input.query.trim().toLowerCase(),
      author: input.author,
      yearFrom: input.yearFrom,
      yearTo: input.yearTo,
      sources: input.sources,
      limit: input.limit,
    });
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 5 * 60_000) {
      return {
        papers: cached.papers,
        providersQueried: input.sources ?? ["openalex", "crossref", "semantic_scholar", "arxiv"],
        providerErrors: {},
      };
    }

    const providers: AcademicSourceProvider[] = input.sources ?? [
      "openalex",
      "crossref",
      "semantic_scholar",
      "arxiv",
    ];
    const limit = input.limit ?? 5;
    const signal = input.signal ?? new AbortController().signal;
    const collected: AcademicPaperMetadata[] = [];
    const providerErrors: Record<string, string> = {};

    for (const provider of providers) {
      try {
        if (provider === "openalex") {
          const url = new URL("https://api.openalex.org/works");
          url.searchParams.set("search", input.query);
          url.searchParams.set("per-page", String(limit));
          const res = await this.fetchImpl(url, {
            headers: { Accept: "application/json" },
            signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as {
            results?: Array<{
              id?: string;
              title?: string;
              publication_year?: number;
              doi?: string;
              type?: string;
              primary_location?: {
                landing_page_url?: string;
                source?: { display_name?: string; type?: string };
              };
              authorships?: Array<{ author?: { display_name?: string } }>;
              abstract_inverted_index?: Record<string, number[]> | null;
            }>;
          };
          const retrievedAt = new Date().toISOString();
          for (const item of body.results ?? []) {
            if (!item.title) continue;
            const year = item.publication_year ?? null;
            if (input.yearFrom && year && year < input.yearFrom) continue;
            if (input.yearTo && year && year > input.yearTo) continue;
            const authors = (item.authorships ?? [])
              .map((a) => a.author?.display_name ?? "")
              .filter(Boolean);
            if (
              input.author &&
              !authors.some((a) =>
                a.toLowerCase().includes(input.author!.toLowerCase()),
              )
            ) {
              continue;
            }
            const abstract = reconstructOpenAlexAbstract(
              item.abstract_inverted_index,
            );
            const isPreprint =
              item.type === "preprint" ||
              item.primary_location?.source?.type === "repository" ||
              /arxiv|biorxiv|medrxiv|ssrn/i.test(
                item.primary_location?.source?.display_name ?? "",
              );
            collected.push({
              id: item.id ?? `openalex:${collected.length + 1}`,
              title: item.title,
              authors,
              year,
              doi: normalizeDoi(item.doi),
              url:
                item.primary_location?.landing_page_url ??
                item.doi ??
                item.id ??
                "https://openalex.org",
              abstract,
              abstractOnly: true,
              venue: item.primary_location?.source?.display_name,
              publicationType: isPreprint ? "preprint" : "peer_reviewed",
              sourceProvider: "openalex",
              retrievedAt,
            });
          }
        } else if (provider === "crossref") {
          const url = new URL("https://api.crossref.org/works");
          url.searchParams.set("query", input.query);
          url.searchParams.set("rows", String(limit));
          const res = await this.fetchImpl(url, {
            headers: { Accept: "application/json" },
            signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as {
            message?: {
              items?: Array<{
                DOI?: string;
                title?: string[];
                URL?: string;
                abstract?: string;
                type?: string;
                "container-title"?: string[];
                published?: { "date-parts"?: number[][] };
                author?: Array<{ given?: string; family?: string }>;
              }>;
            };
          };
          const retrievedAt = new Date().toISOString();
          for (const item of body.message?.items ?? []) {
            const title = item.title?.[0];
            if (!title) continue;
            const year = item.published?.["date-parts"]?.[0]?.[0] ?? null;
            if (input.yearFrom && year && year < input.yearFrom) continue;
            if (input.yearTo && year && year > input.yearTo) continue;
            const authors = (item.author ?? [])
              .map((a) => [a.given, a.family].filter(Boolean).join(" "))
              .filter(Boolean);
            const isPreprint = item.type === "posted-content";
            collected.push({
              id: item.DOI ? `doi:${item.DOI}` : `crossref:${collected.length + 1}`,
              title,
              authors,
              year,
              doi: normalizeDoi(item.DOI),
              url:
                item.URL ??
                (item.DOI ? `https://doi.org/${item.DOI}` : "https://crossref.org"),
              abstract: (item.abstract ?? "").replace(/<[^>]*>/g, "").trim(),
              abstractOnly: true,
              venue: item["container-title"]?.[0],
              publicationType: isPreprint ? "preprint" : "peer_reviewed",
              sourceProvider: "crossref",
              retrievedAt,
            });
          }
        } else if (provider === "semantic_scholar") {
          const url = new URL(
            "https://api.semanticscholar.org/graph/v1/paper/search",
          );
          url.searchParams.set("query", input.query);
          url.searchParams.set("limit", String(limit));
          url.searchParams.set(
            "fields",
            "title,authors,year,abstract,externalIds,url,venue,publicationTypes",
          );
          const headers: Record<string, string> = {
            Accept: "application/json",
          };
          if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
            headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
          }
          const res = await this.fetchImpl(url, { headers, signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as {
            data?: Array<{
              paperId?: string;
              title?: string;
              year?: number;
              abstract?: string;
              url?: string;
              venue?: string;
              publicationTypes?: string[];
              externalIds?: { DOI?: string; ArXiv?: string };
              authors?: Array<{ name?: string }>;
            }>;
          };
          const retrievedAt = new Date().toISOString();
          for (const item of body.data ?? []) {
            if (!item.title) continue;
            const year = item.year ?? null;
            if (input.yearFrom && year && year < input.yearFrom) continue;
            if (input.yearTo && year && year > input.yearTo) continue;
            const isPreprint =
              Boolean(item.externalIds?.ArXiv && !item.externalIds?.DOI) ||
              /arxiv/i.test(item.venue ?? "");
            collected.push({
              id: item.paperId ?? `s2:${collected.length + 1}`,
              title: item.title,
              authors: (item.authors ?? [])
                .map((a) => a.name ?? "")
                .filter(Boolean),
              year,
              doi: normalizeDoi(item.externalIds?.DOI),
              url:
                item.url ??
                (item.externalIds?.DOI
                  ? `https://doi.org/${item.externalIds.DOI}`
                  : "https://www.semanticscholar.org"),
              abstract: (item.abstract ?? "").trim(),
              abstractOnly: true,
              venue: item.venue,
              publicationType: isPreprint ? "preprint" : "peer_reviewed",
              sourceProvider: "semantic_scholar",
              retrievedAt,
            });
          }
        } else if (provider === "arxiv") {
          const url = new URL("https://export.arxiv.org/api/query");
          url.searchParams.set("search_query", `all:${input.query}`);
          url.searchParams.set("max_results", String(limit));
          const res = await this.fetchImpl(url, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const xml = await res.text();
          const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
          const retrievedAt = new Date().toISOString();
          for (const entryMatch of entries) {
            const entry = entryMatch[1]!;
            const id =
              entry.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() ??
              `arxiv:${collected.length + 1}`;
            const title = entry
              .match(/<title>([\s\S]*?)<\/title>/)?.[1]
              ?.replace(/\s+/g, " ")
              .trim();
            if (!title) continue;
            const summary =
              entry
                .match(/<summary>([\s\S]*?)<\/summary>/)?.[1]
                ?.replace(/\s+/g, " ")
                .trim() ?? "";
            const published = entry
              .match(/<published>(\d{4})/)?.[1];
            const year = published ? Number(published) : null;
            if (input.yearFrom && year && year < input.yearFrom) continue;
            if (input.yearTo && year && year > input.yearTo) continue;
            const authors = [
              ...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/g),
            ].map((m) => m[1]!.trim());
            const doi = normalizeDoi(
              entry.match(/<arxiv:doi[^>]*>([\s\S]*?)<\/arxiv:doi>/)?.[1],
            );
            collected.push({
              id,
              title,
              authors,
              year,
              doi,
              url: id,
              abstract: summary,
              abstractOnly: true,
              venue: "arXiv",
              publicationType: "preprint",
              sourceProvider: "arxiv",
              retrievedAt,
            });
          }
        }
      } catch (err) {
        providerErrors[provider] =
          err instanceof Error ? err.message : String(err);
      }
    }

    const deduplicated = deduplicatePapers(collected).slice(0, limit * 2);
    this.cache.set(cacheKey, { timestamp: Date.now(), papers: deduplicated });

    return {
      papers: deduplicated,
      providersQueried: providers,
      providerErrors,
    };
  }
}

export function createAcademicTools(
  options: AcademicToolsOptions = {},
): ToolDefinition<never, unknown>[] {
  const discoveryService = new LiteratureDiscoveryService(options.fetchImpl);

  const discoverLiteratureTool: ToolDefinition<
    {
      query: string;
      author?: string;
      yearFrom?: number;
      yearTo?: number;
      sources?: AcademicSourceProvider[];
      limit?: number;
    },
    {
      papers: AcademicPaperMetadata[];
      providersQueried: AcademicSourceProvider[];
      providerErrors: Record<string, string>;
      evidenceIds: string[];
    }
  > = {
    name: "discover_literature",
    description:
      "Search academic papers across OpenAlex, Crossref, Semantic Scholar, and arXiv. Deduplicates by DOI/title and distinguishes preprints from peer-reviewed papers.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(600),
      author: z.string().trim().optional(),
      yearFrom: z.number().int().min(1900).max(2100).optional(),
      yearTo: z.number().int().min(1900).max(2100).optional(),
      sources: z
        .array(
          z.enum(["openalex", "crossref", "semantic_scholar", "arxiv", "web"]),
        )
        .optional(),
      limit: z.number().int().min(1).max(20).default(5),
    }),
    outputSchema: z.object({
      papers: z.array(z.any()),
      providersQueried: z.array(z.string()),
      providerErrors: z.record(z.string(), z.string()),
      evidenceIds: z.array(z.string()),
    }),
    permission: "network",
    timeoutMs: 15_000,
    errorTypes: ["network_error", "retrieval_error"],
    retryable: true,
    sideEffects: false,
    cancellable: true,
    async execute(
      input,
      context: ToolExecutionContext,
    ): Promise<
      ToolResult<{
        papers: AcademicPaperMetadata[];
        providersQueried: AcademicSourceProvider[];
        providerErrors: Record<string, string>;
        evidenceIds: string[];
      }>
    > {
      const result = await discoveryService.search({
        ...input,
        signal: context.signal,
      });

      const evidenceIds: string[] = [];
      if (options.evidenceStore) {
        for (const paper of result.papers) {
          const ev = options.evidenceStore.add({
            taskId: context.taskId,
            projectId: context.projectId,
            sourceId: paper.doi ?? paper.url ?? paper.id,
            sourceType: "paper",
            url: paper.url,
            ...(paper.doi ? { doi: paper.doi } : {}),
            title: paper.title,
            originalText:
              paper.abstract ||
              `${paper.title} (${paper.authors.join(", ")}, ${paper.year ?? "n.d."})`,
            retrievedAt: paper.retrievedAt,
            metadata: {
              authors: paper.authors,
              year: paper.year,
              venue: paper.venue,
              publicationType: paper.publicationType,
              sourceProvider: paper.sourceProvider,
              abstractOnly: paper.abstractOnly,
            },
          });
          evidenceIds.push(ev.id);
          await context.emit?.(
            "evidence_added",
            `新增学术文献证据 [${ev.id}]：${paper.title}`,
            { evidence: ev },
          );
        }
      }

      return {
        success: true,
        data: {
          ...result,
          evidenceIds,
        },
      };
    },
  };

  const parsePaperTool: ToolDefinition<
    {
      content: string;
      title?: string;
      authors?: string[];
      year?: number;
      doi?: string;
      addToKnowledgeBase?: boolean;
      exportNotePath?: string;
    },
    {
      parsed: ParsedPaperStructure;
      indexedDocumentId?: string;
      exportedNotePath?: string;
      evidenceId?: string;
    }
  > = {
    name: "parse_paper",
    description:
      "Parse academic paper text/PDF-extract into sections, tables, formulas, figure captions, and locator warnings. Can index into the project knowledge base and export Markdown notes.",
    inputSchema: z.object({
      content: z.string().min(1).max(200_000),
      title: z.string().optional(),
      authors: z.array(z.string()).optional(),
      year: z.number().int().optional(),
      doi: z.string().optional(),
      addToKnowledgeBase: z.boolean().default(false),
      exportNotePath: z.string().optional(),
    }),
    outputSchema: z.object({
      parsed: z.any(),
      indexedDocumentId: z.string().optional(),
      exportedNotePath: z.string().optional(),
      evidenceId: z.string().optional(),
    }),
    permission: "read",
    timeoutMs: 15_000,
    errorTypes: ["tool_error", "permission_error"],
    retryable: false,
    sideEffects: true,
    cancellable: true,
    async execute(input, context) {
      const parsed = parseAcademicPaperText(input.content, {
        title: input.title,
        authors: input.authors,
        year: input.year,
        doi: input.doi,
      });

      let indexedDocumentId: string | undefined;
      if (input.addToKnowledgeBase && options.rag) {
        const safeName = `${parsed.title.replace(/[^a-zA-Z0-9\u4e00-\u9fff._-]+/g, "_").slice(0, 40) || "paper"}.md`;
        const uploaded = await options.rag.upload(
          safeName,
          parsed.structuredMarkdown.slice(0, 23_000),
          context.signal,
          context.projectId,
        );
        indexedDocumentId = uploaded.id;
      }

      let exportedNotePath: string | undefined;
      if (input.exportNotePath) {
        if (!context.permissions.has("write")) {
          return {
            success: false,
            error: {
              code: "PERMISSION_DENIED",
              message: "Write permission is required to export paper notes.",
              retryable: false,
              category: "permission_error",
            },
          };
        }
        const { resolvedPath } = await resolveWorkspacePath(
          context.workspaceRoot,
          input.exportNotePath,
        );
        await mkdir(dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, parsed.structuredMarkdown, "utf8");
        exportedNotePath = resolvedPath;
      }

      let evidenceId: string | undefined;
      if (options.evidenceStore) {
        const ev = options.evidenceStore.add({
          taskId: context.taskId,
          projectId: context.projectId,
          sourceId: parsed.doi ?? parsed.title,
          sourceType: "paper",
          ...(parsed.doi ? { doi: parsed.doi } : {}),
          title: parsed.title,
          originalText: (parsed.abstract || parsed.structuredMarkdown).slice(
            0,
            2000,
          ),
          locator: {
            page: 1,
            section: parsed.sections[0]?.heading ?? "Abstract",
            startOffset: 0,
            endOffset: Math.min(2000, input.content.length),
          },
          metadata: {
            authors: parsed.authors,
            year: parsed.year,
            abstractOnly: parsed.sections.length === 0 && Boolean(parsed.abstract),
            unparsedRegions: parsed.unparsedRegions,
          },
        });
        evidenceId = ev.id;
      }

      return {
        success: true,
        data: {
          parsed,
          ...(indexedDocumentId ? { indexedDocumentId } : {}),
          ...(exportedNotePath ? { exportedNotePath } : {}),
          ...(evidenceId ? { evidenceId } : {}),
        },
      };
    },
  };

  return [
    discoverLiteratureTool,
    parsePaperTool,
  ] as unknown as ToolDefinition<never, unknown>[];
}

export function registerAcademicTools(
  registry: ToolRegistry,
  options: AcademicToolsOptions = {},
): ToolRegistry {
  for (const tool of createAcademicTools(options)) {
    registry.register(tool);
  }
  return registry;
}
