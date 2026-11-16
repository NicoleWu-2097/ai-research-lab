import { describe, expect, it } from "vitest";

import { assertNoOllama } from "../src/config/no-ollama.js";

describe("assertNoOllama", () => {
  it("rejects an ollama chat provider while the switch is on", () => {
    expect(() =>
      assertNoOllama({
        OLLAMA_DISABLED: "true",
        LLM_PROVIDER: "ollama",
        EMBEDDING_PROVIDER: "voyage",
      }),
    ).toThrow(/LLM_PROVIDER/);
  });

  it("rejects an ollama embedding provider while the switch is on", () => {
    expect(() =>
      assertNoOllama({
        OLLAMA_DISABLED: "true",
        LLM_PROVIDER: "openai",
        EMBEDDING_PROVIDER: "ollama",
      }),
    ).toThrow(/EMBEDDING_PROVIDER/);
  });

  it("names both providers when both use ollama", () => {
    expect(() =>
      assertNoOllama({
        OLLAMA_DISABLED: "true",
        LLM_PROVIDER: "ollama",
        EMBEDDING_PROVIDER: "ollama",
      }),
    ).toThrow(/LLM_PROVIDER.*EMBEDDING_PROVIDER/);
  });

  it("accepts any provider combination while the switch is off", () => {
    for (const env of [
      {},
      { LLM_PROVIDER: "ollama", EMBEDDING_PROVIDER: "ollama" },
      {
        OLLAMA_DISABLED: "false",
        LLM_PROVIDER: "ollama",
        EMBEDDING_PROVIDER: "ollama",
      },
    ])
      expect(() => assertNoOllama(env)).not.toThrow();
  });

  it("accepts external providers while the switch is on", () => {
    expect(() =>
      assertNoOllama({
        OLLAMA_DISABLED: "true",
        LLM_PROVIDER: "openai",
        EMBEDDING_PROVIDER: "jina",
      }),
    ).not.toThrow();
  });
});
