import type { z } from "zod";

export type ProviderName = "openai" | "ollama";

export type ModelErrorCode =
  | "MODEL_NOT_CONFIGURED"
  | "MODEL_TIMEOUT"
  | "MODEL_CANCELLED"
  | "MODEL_UNSUPPORTED_CAPABILITY"
  | "MODEL_INVALID_OUTPUT"
  | "MODEL_PROVIDER_ERROR";

export class ModelError extends Error {
  constructor(
    public readonly code: ModelErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ModelError";
  }
}

export interface ModelProvider {
  readonly provider: ProviderName;
  readonly model: string;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
  stream(prompt: string, signal: AbortSignal): AsyncIterable<string>;
  structuredOutput<T>(
    prompt: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T>;
}

export function toModelError(error: unknown, signal: AbortSignal): ModelError {
  if (signal.aborted && signal.reason instanceof ModelError)
    return signal.reason;
  if (error instanceof ModelError) return error;

  if (
    error instanceof Error &&
    /unsupported|not supported|does not support/i.test(error.message)
  ) {
    return new ModelError(
      "MODEL_UNSUPPORTED_CAPABILITY",
      "The selected model does not support this operation.",
      { cause: error },
    );
  }

  return new ModelError("MODEL_PROVIDER_ERROR", "The model request failed.", {
    cause: error,
  });
}
