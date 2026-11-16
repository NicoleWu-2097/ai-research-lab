import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { LocalRetriever } from "../research/agentic.js";

const responseSchema = z.object({
  grounding: z
    .object({
      generic: z
        .array(
          z.object({
            url: z.string(),
            title: z.string().nullish(),
            snippets: z.array(z.string()).nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
  sources: z
    .record(
      z.string(),
      z.object({
        title: z.string().nullish(),
        hostname: z.string().nullish(),
        age: z.array(z.string()).nullish(),
      }),
    )
    .nullish(),
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().nullish(),
            url: z.string(),
            description: z.string().nullish(),
            extra_snippets: z.array(z.string()).nullish(),
          }),
        )
        .nullish(),
    })
    .nullish(),
});

function cleanSnippetText(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export interface BraveLlmContextOptions {
  count?: number | undefined;
  country?: string | undefined;
  searchLang?: string | undefined;
  freshness?: "pd" | "pw" | "pm" | "py" | string | undefined;
  maxTokens?: number | undefined;
  maximumNumberOfSnippets?: number | undefined;
  maximumNumberOfSnippetsPerUrl?: number | undefined;
}

/**
 * Brave Search LLM Context API client (`GET https://api.search.brave.com/res/v1/llm/context`).
 * Extracts pre-formatted web context snippets for AI agent grounding and evidence verification.
 */
export class BraveSearch implements LocalRetriever {
  constructor(
    private readonly key: string,
    private readonly defaultOptions: BraveLlmContextOptions = {},
  ) {}

  async retrieve(
    query: string,
    signal: AbortSignal,
    options?: BraveLlmContextOptions,
  ) {
    if (query.length > 600 || query.split(/\s+/).length > 75)
      throw new Error("Search query exceeds provider limits");

    const merged = { ...this.defaultOptions, ...options };
    const url = new URL("https://api.search.brave.com/res/v1/llm/context");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(merged.count ?? 5));
    if (merged.country) url.searchParams.set("country", merged.country);
    if (merged.searchLang)
      url.searchParams.set("search_lang", merged.searchLang);
    if (merged.freshness) url.searchParams.set("freshness", merged.freshness);
    if (merged.maxTokens)
      url.searchParams.set("max_tokens", String(merged.maxTokens));
    if (merged.maximumNumberOfSnippets)
      url.searchParams.set(
        "maximum_number_of_snippets",
        String(merged.maximumNumberOfSnippets),
      );
    if (merged.maximumNumberOfSnippetsPerUrl)
      url.searchParams.set(
        "maximum_number_of_snippets_per_url",
        String(merged.maximumNumberOfSnippetsPerUrl),
      );

    const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(12_000)]);
    const cleanKey = this.key.trim().replace(/^["']|["']$/g, "");
    let response = await fetch(url, {
      headers: {
        "X-Subscription-Token": cleanKey,
        Accept: "application/json",
      },
      signal: fetchSignal,
      redirect: "error",
    });
    if ([403, 404, 422].includes(response.status)) {
      const fallbackUrl = new URL(
        "https://api.search.brave.com/res/v1/web/search",
      );
      fallbackUrl.searchParams.set("q", query);
      fallbackUrl.searchParams.set("count", String(merged.count ?? 5));
      if (merged.country) fallbackUrl.searchParams.set("country", merged.country);
      if (merged.searchLang)
        fallbackUrl.searchParams.set("search_lang", merged.searchLang);
      if (merged.freshness)
        fallbackUrl.searchParams.set("freshness", merged.freshness);
      response = await fetch(fallbackUrl, {
        headers: {
          "X-Subscription-Token": cleanKey,
          Accept: "application/json",
        },
        signal: fetchSignal,
        redirect: "error",
      });
    }
    if (!response.ok) throw new Error(`Search failed (${response.status})`);

    const body = responseSchema.parse(await response.json());
    const retrievedAt = new Date().toISOString();

    // 1. Parse Brave LLM Context `grounding.generic` payload
    const genericItems = (body.grounding?.generic ?? [])
      .map((item) => {
        const rawText = (item.snippets ?? [])
          .map((s) => cleanSnippetText(s))
          .filter(Boolean)
          .join("\n\n");
        const title =
          (item.title ?? "").trim() ||
          body.sources?.[item.url]?.title?.trim() ||
          item.url;
        return {
          url: item.url,
          title,
          description: rawText,
        };
      })
      .filter((r) => /^https?:\/\//.test(r.url) && r.description.trim());

    // 2. Fallback to `web.results` if `grounding.generic` is empty
    const webItems = (body.web?.results ?? [])
      .map((r) => {
        const combined = [r.description ?? "", ...(r.extra_snippets ?? [])]
          .map((s) => cleanSnippetText(s))
          .filter(Boolean)
          .join("\n\n");
        return {
          url: r.url,
          title: (r.title ?? "").trim() || r.url,
          description: combined,
        };
      })
      .filter((r) => /^https?:\/\//.test(r.url) && r.description.trim());

    const normalizedResults =
      genericItems.length > 0 ? genericItems : webItems;

    return normalizedResults.slice(0, merged.count ?? 5).map((r) => {
      const content = r.description.slice(0, 2000);
      const sha256 = createHash("sha256").update(content).digest("hex");
      return {
        id: `WEB:${createHash("sha256")
          .update(r.url + sha256)
          .digest("hex")}`,
        documentId: r.url,
        content,
        sha256,
        retrievedAt,
        ingestedAt: retrievedAt,
        start: 0,
        end: content.length,
        startLine: 1,
        endLine: content.split("\n").length,
        score: 0,
        url: r.url,
        title: r.title,
        sourceKind: "search_snippet" as const,
      };
    });
  }
}

export class DynamicBraveSearch implements LocalRetriever {
  constructor(private readonly defaultOptions: BraveLlmContextOptions = {}) {}

  private resolveKey(): string {
    let key = (
      process.env.BRAVE_SEARCH_API_KEY ??
      process.env.BRAVE_API_KEY ??
      ""
    ).trim();
    if (!key && existsSync(".env")) {
      try {
        process.loadEnvFile(".env");
        key = (
          process.env.BRAVE_SEARCH_API_KEY ??
          process.env.BRAVE_API_KEY ??
          ""
        ).trim();
      } catch {
        // ignore env load errors
      }
    }
    return key.replace(/^["']|["']$/g, "");
  }

  isConfigured(): boolean {
    return this.resolveKey().length > 0;
  }

  async retrieve(
    query: string,
    signal: AbortSignal,
    options?: BraveLlmContextOptions,
  ) {
    const key = this.resolveKey();
    if (!key) {
      throw new Error(
        "BRAVE_SEARCH_API_KEY is not configured in apps/api/.env",
      );
    }
    return new BraveSearch(key, this.defaultOptions).retrieve(
      query,
      signal,
      options,
    );
  }
}

export function isWebRetrieverReady(web: LocalRetriever | null): boolean {
  if (!web) return false;
  if ("isConfigured" in web && typeof web.isConfigured === "function") {
    return Boolean((web as DynamicBraveSearch).isConfigured());
  }
  return true;
}
