import { expect, it, vi } from "vitest";
import { z } from "zod";
import { ChatCompletionsProvider } from "../src/model/chat-completions.js";
import { createModelProvider, readModelConfig } from "../src/model/config.js";
const signal = new AbortController().signal;
it("matches the supplied HKUST URL, api-key header, messages and choices response", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(String(input)).toBe(
      "https://hkust.azure-api.net/hkust-genai/v1/chat/completions",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("api-key")).toBe("test-key");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("content-type")).toContain("application/json");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[1]).toMatchObject({ role: "user", content: "hello" });
    if (body.stream)
      return new Response(
        'data: {"choices":[{"delta":{"content":"res"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"ponse"},"finish_reason":"stop"}]}\n\n' +
          "data: [DONE]\n\n",
        { headers: { "Content-Type": "text/event-stream" } },
      );
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "response" },
        },
      ],
    });
  });
  const provider = new ChatCompletionsProvider(
    "gpt-4o-mini",
    "test-key",
    "https://hkust.azure-api.net/hkust-genai/v1",
    "api-key",
    fetcher,
  );
  expect(await provider.generate("hello", signal)).toBe("response");
  const chunks = [];
  for await (const chunk of provider.stream("hello", signal))
    chunks.push(chunk);
  expect(chunks).toEqual(["res", "ponse"]);
});
it("validates structured responses and rejects truncation", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({
      choices: [
        { finish_reason: "stop", message: { content: '{"answer":"yes"}' } },
      ],
    }),
  );
  const p = new ChatCompletionsProvider(
    "gpt-4o-mini",
    "test",
    "https://example.com/v1",
    "api-key",
    fetcher,
  );
  expect(
    await p.structuredOutput("json", z.object({ answer: z.string() }), signal),
  ).toEqual({ answer: "yes" });
  fetcher.mockImplementationOnce(async () =>
    Response.json({
      choices: [{ finish_reason: "length", message: { content: "partial" } }],
    }),
  );
  await expect(p.generate("text", signal)).rejects.toMatchObject({
    code: "MODEL_INVALID_OUTPUT",
  });
  fetcher.mockImplementationOnce(async () =>
    Response.json({
      choices: [{ finish_reason: "stop", message: { content: "not json" } }],
    }),
  );
  await expect(
    p.structuredOutput("json", z.object({ answer: z.string() }), signal),
  ).rejects.toMatchObject({ code: "MODEL_INVALID_OUTPUT" });
});
it("selects the gateway adapter from configuration and requires a user-provided key", () => {
  const env = {
    LLM_PROVIDER: "openai",
    OPENAI_MODEL: "gpt-4o-mini",
    OPENAI_API_KEY: "test",
    OPENAI_BASE_URL: "https://hkust.azure-api.net/hkust-genai/v1",
    OPENAI_API_STYLE: "chat-completions",
    OPENAI_AUTH_HEADER: "api-key",
  };
  expect(createModelProvider(readModelConfig(env)!)).toBeInstanceOf(
    ChatCompletionsProvider,
  );
  expect(() => readModelConfig({ ...env, OPENAI_API_KEY: "" })).toThrow();
});
