import { afterEach, expect, it, vi } from "vitest";
import { BraveSearch } from "../src/search/brave.js";
afterEach(() => vi.unstubAllGlobals());
it("keeps snippet provenance and sends credentials only to the search endpoint", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        web: {
          results: [
            {
              title: "Example",
              url: "https://example.com/page",
              description: "<b>Source</b> excerpt",
            },
          ],
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const [hit] = await new BraveSearch("secret").retrieve(
    "test",
    new AbortController().signal,
  );
  expect(hit).toMatchObject({
    content: "Source excerpt",
    url: "https://example.com/page",
    sourceKind: "search_snippet",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]![0])).toContain(
    "https://api.search.brave.com/res/v1/llm/context",
  );
});
it("parses Brave LLM Context grounding.generic snippets and sources metadata", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        grounding: {
          generic: [
            {
              url: "https://docs.brave.com/llm-context",
              title: "",
              snippets: [
                "First extracted LLM context chunk.",
                "<b>Second</b> grounded chunk.",
              ],
            },
          ],
        },
        sources: {
          "https://docs.brave.com/llm-context": {
            title: "Brave LLM Context Documentation",
            hostname: "docs.brave.com",
          },
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const hits = await new BraveSearch("secret-key", {
    count: 3,
    freshness: "pw",
  }).retrieve("brave llm context", new AbortController().signal);
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({
    url: "https://docs.brave.com/llm-context",
    title: "Brave LLM Context Documentation",
    content: "First extracted LLM context chunk.\n\nSecond grounded chunk.",
    sourceKind: "search_snippet",
  });
  const calledUrl = String(fetcher.mock.calls[0]![0]);
  expect(calledUrl).toContain(
    "https://api.search.brave.com/res/v1/llm/context",
  );
  expect(calledUrl).toContain("freshness=pw");
});
it("does not disguise provider failure as empty evidence", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("", { status: 429 })),
  );
  await expect(
    new BraveSearch("secret").retrieve("test", new AbortController().signal),
  ).rejects.toThrow("429");
});
it("rejects overlong queries before sending data", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  await expect(
    new BraveSearch("secret").retrieve(
      "x".repeat(601),
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
