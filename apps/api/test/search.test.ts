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
    "https://api.search.brave.com/",
  );
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
