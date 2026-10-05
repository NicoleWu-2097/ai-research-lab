import { ModelError } from "./types.js";

export function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signal.reason);
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function createDeadline(parent: AbortSignal, timeoutMs: number) {
  const controller = new AbortController();
  const cancel = () =>
    controller.abort(
      new ModelError("MODEL_CANCELLED", "The model request was cancelled."),
    );

  if (parent.aborted) cancel();
  else parent.addEventListener("abort", cancel, { once: true });

  const timer = setTimeout(() => {
    controller.abort(
      new ModelError("MODEL_TIMEOUT", "The model request timed out."),
    );
  }, timeoutMs);

  return {
    signal: controller.signal,
    cancel,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", cancel);
    },
  };
}
