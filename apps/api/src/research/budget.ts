import { z } from "zod";
import {
  MAX_OUTPUT_TOKENS,
  ModelError,
  type ModelProvider,
} from "../model/types.js";
import { raceWithAbort } from "../model/deadline.js";

export class BudgetExceeded extends Error {}
/** Reservation units: UTF-8 input bytes + output allowance; not billed token usage. */
export class ResearchBudget {
  calls = 0;
  units = 0;
  retries = 0;
  constructor(
    readonly maxCalls = 28,
    readonly maxUnits = 3200000,
  ) {}
  reserve(units: number, holdFinal = false) {
    if (
      this.calls >= this.maxCalls - (holdFinal ? 1 : 0) ||
      this.units + units >
        this.maxUnits - (holdFinal ? Math.min(64000, this.maxUnits) : 0)
    )
      throw new BudgetExceeded();
    this.calls++;
    this.units += units;
  }
  remote(holdFinal = false) {
    this.reserve(200000, holdFinal);
  }
  wrap(provider: ModelProvider, holdFinal = false): ModelProvider {
    const reserve = (prompt: string, schema = "") =>
      this.reserve(
        Buffer.byteLength(prompt) +
          2 * Buffer.byteLength(schema) +
          2048 +
          MAX_OUTPUT_TOKENS,
        holdFinal,
      );
    const call = async <T>(
      prompt: string,
      schema: string,
      signal: AbortSignal,
      operation: () => Promise<T>,
    ): Promise<T> => {
      signal.throwIfAborted();
      reserve(prompt, schema);
      try {
        return await raceWithAbort(operation(), signal);
      } catch (error) {
        if (
          signal.aborted ||
          !(error instanceof ModelError) ||
          error.code !== "MODEL_PROVIDER_ERROR" ||
          this.retries >= 1
        )
          throw error;
        this.retries++;
        reserve(prompt, schema);
        return raceWithAbort(operation(), signal);
      }
    };
    return {
      provider: provider.provider,
      model: provider.model,
      generate: (prompt, signal) =>
        call(prompt, "", signal, () => provider.generate(prompt, signal)),
      structuredOutput: (prompt, schema, signal) =>
        call(prompt, JSON.stringify(z.toJSONSchema(schema)), signal, () =>
          provider.structuredOutput(prompt, schema, signal),
        ),
      async *stream(prompt, signal) {
        signal.throwIfAborted();
        reserve(prompt);
        // Streaming attempts are never replayed after partial output.
        yield* provider.stream(prompt, signal);
      },
    };
  }
}
