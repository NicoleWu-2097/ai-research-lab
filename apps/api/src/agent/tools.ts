import { z } from "zod";
import { createDeadline, raceWithAbort } from "../model/deadline.js";
import type {
  FailureCategory,
  ToolDefinition,
  ToolExecutionContext,
  ToolPermission,
  ToolResult,
} from "./types.js";

export function classifyError(error: unknown): {
  category: FailureCategory;
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof z.ZodError) {
    return {
      category: "schema_error",
      code: "SCHEMA_VALIDATION_ERROR",
      message: error.issues.map((i) => i.message).join("; "),
      retryable: true,
    };
  }
  if (error && typeof error === "object") {
    const code = "code" in error ? String(error.code) : "";
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");

    if (
      code === "EACCES" ||
      code === "EPERM" ||
      code === "PERMISSION_DENIED" ||
      /permission|forbidden|traversal|outside workspace|not authorized/i.test(
        message,
      )
    ) {
      return {
        category: "permission_error",
        code: code || "PERMISSION_DENIED",
        message,
        retryable: false,
      };
    }

    if (
      code === "MODEL_TIMEOUT" ||
      code === "ETIMEDOUT" ||
      code === "ECONNREFUSED" ||
      code === "ENOTFOUND" ||
      code === "ECONNRESET" ||
      /timeout|timed out|fetch failed|network|rate limit|429|503/i.test(message)
    ) {
      return {
        category: "network_error",
        code: code || "NETWORK_ERROR",
        message,
        retryable: true,
      };
    }

    if (code === "MODEL_INVALID_OUTPUT") {
      return {
        category: "schema_error",
        code,
        message,
        retryable: true,
      };
    }

    if (code.startsWith("MODEL_")) {
      return {
        category: "model_error",
        code,
        message,
        retryable: code === "MODEL_PROVIDER_ERROR",
      };
    }

    if (code === "RAG_FAILED" || /retrieval|embedding|ollama/i.test(message)) {
      return {
        category: "retrieval_error",
        code: code || "RETRIEVAL_ERROR",
        message,
        retryable: true,
      };
    }
  }

  const msg =
    error instanceof Error ? error.message : String(error ?? "Tool error");
  return {
    category: "tool_error",
    code: "TOOL_EXECUTION_FAILED",
    message: msg,
    retryable: false,
  };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<never, unknown>>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): this {
    this.tools.set(
      tool.name,
      tool as unknown as ToolDefinition<never, unknown>,
    );
    return this;
  }

  get(name: string): ToolDefinition<never, unknown> | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition<never, unknown>[] {
    return [...this.tools.values()];
  }

  describeForPrompt(allowedPermissions?: Set<ToolPermission>): Array<{
    name: string;
    description: string;
    permission: ToolPermission;
    sideEffects: boolean;
    schema: unknown;
  }> {
    return this.list()
      .filter(
        (t) =>
          !allowedPermissions ||
          t.permission === "none" ||
          allowedPermissions.has(t.permission),
      )
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        permission: tool.permission,
        sideEffects: tool.sideEffects,
        schema: z.toJSONSchema(tool.inputSchema),
      }));
  }

  async execute<TOutput = unknown>(
    name: string,
    rawInput: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolResult<TOutput> & { latencyMs: number }> {
    const startedAt = Date.now();
    const tool = this.tools.get(name);
    if (!tool) {
      const error = {
        code: "TOOL_NOT_FOUND",
        message: `Tool "${name}" is not registered.`,
        retryable: false,
        category: "tool_error" as const,
      };
      await context.emit?.("tool_failed", `工具不存在：${name}`, {
        tool: name,
        error,
      });
      return {
        success: false,
        error,
        latencyMs: Date.now() - startedAt,
      };
    }

    if (
      tool.permission !== "none" &&
      !context.permissions.has(tool.permission)
    ) {
      const error = {
        code: "PERMISSION_DENIED",
        message: `Tool "${name}" requires "${tool.permission}" permission which is not granted in this context.`,
        retryable: false,
        category: "permission_error" as const,
      };
      await context.emit?.("tool_failed", `工具权限不足：${name}`, {
        tool: name,
        permission: tool.permission,
        error,
      });
      return {
        success: false,
        error,
        latencyMs: Date.now() - startedAt,
      };
    }

    const parsedInput = tool.inputSchema.safeParse(rawInput);
    if (!parsedInput.success) {
      const error = {
        code: "INVALID_TOOL_INPUT",
        message: `Invalid arguments for "${name}": ${parsedInput.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        retryable: true,
        category: "schema_error" as const,
      };
      await context.emit?.("tool_failed", `工具参数无效：${name}`, {
        tool: name,
        error,
      });
      return {
        success: false,
        error,
        latencyMs: Date.now() - startedAt,
      };
    }

    await context.emit?.("tool_started", `开始执行工具：${name}`, {
      tool: name,
      arguments: parsedInput.data,
    });

    const deadline = createDeadline(context.signal, tool.timeoutMs);
    try {
      const result = await raceWithAbort(
        (tool.execute as (
          input: unknown,
          ctx: ToolExecutionContext,
        ) => Promise<ToolResult<unknown>>)(parsedInput.data, {
          ...context,
          signal: deadline.signal,
        }),
        deadline.signal,
      );

      if (!result.success) {
        await context.emit?.(
          "tool_failed",
          `工具执行失败：${name} — ${result.error.message}`,
          {
            tool: name,
            error: result.error,
          },
        );
        return {
          ...result,
          latencyMs: Date.now() - startedAt,
        };
      }

      const parsedOutput = tool.outputSchema.safeParse(result.data);
      if (!parsedOutput.success) {
        const error = {
          code: "INVALID_TOOL_OUTPUT",
          message: `Tool "${name}" output did not match its contract.`,
          retryable: false,
          category: "schema_error" as const,
        };
        await context.emit?.("tool_failed", `工具输出格式异常：${name}`, {
          tool: name,
          error,
        });
        return {
          success: false,
          error,
          latencyMs: Date.now() - startedAt,
        };
      }

      const latencyMs = Date.now() - startedAt;
      await context.emit?.("tool_completed", `工具执行完成：${name}`, {
        tool: name,
        latencyMs,
        metadata: result.metadata,
      });
      return {
        success: true,
        data: parsedOutput.data as TOutput,
        ...(result.metadata ? { metadata: result.metadata } : {}),
        latencyMs,
      };
    } catch (err) {
      if (context.signal.aborted) throw context.signal.reason ?? err;
      const classified = classifyError(
        deadline.signal.aborted ? deadline.signal.reason : err,
      );
      const error = {
        code: classified.code,
        message: classified.message,
        retryable: tool.retryable && classified.retryable,
        category: classified.category,
      };
      await context.emit?.(
        "tool_failed",
        `工具异常：${name} — ${error.message}`,
        {
          tool: name,
          error,
        },
      );
      return {
        success: false,
        error,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      deadline.dispose();
    }
  }
}
