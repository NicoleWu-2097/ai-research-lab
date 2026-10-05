import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createApp } from "../src/app.js";
import { createModelProvider, readModelConfig } from "../src/model/config.js";
import type { ModelProvider } from "../src/model/types.js";

const fakeProvider: ModelProvider = {
  provider: "ollama",
  model: "fake-model",
  async generate(prompt) {
    return `answer: ${prompt}`;
  },
  async *stream(prompt) {
    yield `answer: `;
    yield prompt;
  },
  async structuredOutput<T>(_prompt: string, schema: z.ZodType<T>): Promise<T> {
    return schema.parse({ answer: "fake" });
  },
};

const post = (
  app: ReturnType<typeof createApp>,
  path: string,
  prompt: unknown,
) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt }),
  });

describe("model configuration", () => {
  it("selects Ollama and OpenAI without changing caller code", () => {
    const ollama = readModelConfig({
      LLM_PROVIDER: "ollama",
      OLLAMA_MODEL: "local-example",
    });
    const openai = readModelConfig({
      LLM_PROVIDER: "openai",
      OPENAI_MODEL: "hosted-example",
      OPENAI_API_KEY: "test-key",
    });

    expect(ollama && createModelProvider(ollama).provider).toBe("ollama");
    expect(openai && createModelProvider(openai).provider).toBe("openai");
    expect(readModelConfig({})).toBeNull();
  });

  it("rejects a selected provider with missing model settings", () => {
    expect(() => readModelConfig({ LLM_PROVIDER: "ollama" })).toThrow();
    expect(() =>
      readModelConfig({ LLM_PROVIDER: "openai", OPENAI_MODEL: "example" }),
    ).toThrow();
  });
});

describe("model HTTP boundary", () => {
  it("returns a normal response from an injected provider", async () => {
    const response = await post(
      createApp(fakeProvider),
      "/api/model/generate",
      "hello",
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      provider: "ollama",
      model: "fake-model",
      text: "answer: hello",
    });
  });

  it("streams deltas and a completion event", async () => {
    const response = await post(
      createApp(fakeProvider),
      "/api/model/stream",
      "hello",
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: delta");
    expect(body).toContain('data: {"text":"answer: "}');
    expect(body).toContain('data: {"text":"hello"}');
    expect(body).toContain("event: done");
  });

  it("validates prompt and reports an unconfigured provider", async () => {
    const app = createApp(null);
    expect((await post(app, "/api/model/generate", " ")).status).toBe(400);
    const response = await post(app, "/api/model/generate", "hello");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "MODEL_NOT_CONFIGURED",
        message: "Set LLM_PROVIDER and its model settings.",
      },
    });
  });

  it("stops a provider that ignores the abort signal at the deadline", async () => {
    const stalled: ModelProvider = {
      ...fakeProvider,
      generate: () => new Promise(() => undefined),
    };
    const response = await post(
      createApp(stalled, 5),
      "/api/model/generate",
      "hello",
    );
    expect(response.status).toBe(504);
    expect(await response.json()).toEqual({
      error: { code: "MODEL_TIMEOUT", message: "The model request timed out." },
    });
  });

  it("ends a stalled SSE stream with a timeout event", async () => {
    const stalled: ModelProvider = {
      ...fakeProvider,
      async *stream() {
        await new Promise(() => undefined);
        yield "never";
      },
    };
    const response = await post(
      createApp(stalled, 5),
      "/api/model/stream",
      "hello",
    );
    const body = await response.text();
    expect(body).toContain("event: error");
    expect(body).toContain('"code":"MODEL_TIMEOUT"');
    expect(body).not.toContain("event: done");
  });

  it("keeps provider errors typed and hides their raw message", async () => {
    const failed: ModelProvider = {
      ...fakeProvider,
      generate: () => Promise.reject(new Error("secret upstream detail")),
    };
    const response = await post(
      createApp(failed),
      "/api/model/generate",
      "hello",
    );
    expect(response.status).toBe(502);
    expect((await response.json()).error).toEqual({
      code: "MODEL_PROVIDER_ERROR",
      message: "The model request failed.",
    });
  });

  it("validates structured output through the provider contract", async () => {
    expect(
      await fakeProvider.structuredOutput(
        "hello",
        z.object({ answer: z.string() }),
        new AbortController().signal,
      ),
    ).toEqual({ answer: "fake" });
  });
});
