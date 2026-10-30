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
    readonly maxCalls = 12,
    readonly maxUnits = 1600000,
  ) {}
  reserve(units: number) {
    if (this.calls >= this.maxCalls || this.units + units > this.maxUnits)
      throw new BudgetExceeded();
    this.calls++;
    this.units += units;
  }
  remote() {
    this.reserve(200000);
  }
  wrap(provider: ModelProvider): ModelProvider {
    const reserve = (prompt: string, schema = "") =>
      this.reserve(
        Buffer.byteLength(prompt) +
          2 * Buffer.byteLength(schema) +
          2048 +
          MAX_OUTPUT_TOKENS,
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
