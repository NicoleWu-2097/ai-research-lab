import { createHash } from "node:crypto";
import { z } from "zod";
import type { LocalRetriever } from "../research/agentic.js";
const responseSchema = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string(),
            url: z.url(),
            description: z.string().default(""),
          }),
        )
        .default([]),
    })
    .optional(),
});
/** Search snippets are evidence snapshots, never presented as fetched page bodies. */
export class BraveSearch implements LocalRetriever {
  constructor(private readonly key: string) {}
  async retrieve(query: string, signal: AbortSignal) {
    if (query.length > 600 || query.split(/\s+/).length > 75)
      throw new Error("Search query exceeds provider limits");
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", "5");
    const response = await fetch(url, {
      headers: { "X-Subscription-Token": this.key, Accept: "application/json" },
      signal,
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Search failed (${response.status})`);
    const body = responseSchema.parse(await response.json());
    const retrievedAt = new Date().toISOString();
    return (body.web?.results ?? [])
      .filter((r) => /^https?:\/\//.test(r.url) && r.description.trim())
      .slice(0, 5)
      .map((r) => {
        const content = r.description.replace(/<[^>]*>/g, "").slice(0, 2000);
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
