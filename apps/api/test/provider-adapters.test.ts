import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OllamaProvider } from "../src/model/ollama.js";
import { OpenAIProvider } from "../src/model/openai.js";

const signal = new AbortController().signal;

const openAIResponse = (text: string) => ({
  id: "resp_test",
  object: "response",
  created_at: 0,
  status: "completed",
  model: "hosted-test",
  output: [
    {
      id: "msg_test",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
});

describe("Ollama SDK adapter", () => {
  it("sends the configured model and parses text and structured output", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        format?: unknown;
      };
      expect(request.model).toBe("local-test");
      const content = request.format ? '{"answer":"yes"}' : "hello";
      return new Response(
        JSON.stringify({
          model: "local-test",
          message: { role: "assistant", content },
          done: true,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const provider = new OllamaProvider(
      "local-test",
      "http://localhost:11434",
      fetchImpl,
    );

    expect(await provider.generate("say hello", signal)).toBe("hello");
    expect(
      await provider.structuredOutput(
        "answer yes",
        z.object({ answer: z.string() }),
        signal,
      ),
    ).toEqual({ answer: "yes" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reads streamed text chunks", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          [
            JSON.stringify({ message: { content: "hello" }, done: false }),
            JSON.stringify({ message: { content: " world" }, done: true }),
          ].join("\n") + "\n",
          { status: 200, headers: { "Content-Type": "application/x-ndjson" } },
        ),
    );
    const provider = new OllamaProvider(
      "local-test",
      "http://localhost:11434",
      fetchImpl,
    );
    const chunks: string[] = [];
    for await (const chunk of provider.stream("hello", signal))
      chunks.push(chunk);
    expect(chunks).toEqual(["hello", " world"]);
  });
});

describe("OpenAI SDK adapter", () => {
  it("sends the configured model and parses text and structured output", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        model: string;
        text?: unknown;
      };
      expect(request.model).toBe("hosted-test");
      return new Response(
        JSON.stringify(
          openAIResponse(request.text ? '{"answer":"yes"}' : "hello"),
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const provider = new OpenAIProvider("hosted-test", "test-key", fetchImpl);

    expect(await provider.generate("say hello", signal)).toBe("hello");
    expect(
      await provider.structuredOutput(
        "answer yes",
        z.object({ answer: z.string() }),
        signal,
      ),
    ).toEqual({ answer: "yes" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reads streamed text delta events", async () => {
    const events = [
      { type: "response.output_text.delta", delta: "hello" },
      { type: "response.output_text.delta", delta: " world" },
      { type: "response.completed", response: openAIResponse("hello world") },
    ];
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    const provider = new OpenAIProvider("hosted-test", "test-key", fetchImpl);
    const chunks: string[] = [];
    for await (const chunk of provider.stream("hello", signal))
      chunks.push(chunk);
    expect(chunks).toEqual(["hello", " world"]);
  });
});
