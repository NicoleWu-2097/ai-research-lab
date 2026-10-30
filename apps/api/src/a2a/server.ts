import { randomUUID } from "node:crypto";
import express from "express";
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  Message,
  Role,
  Task,
  TaskState,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
} from "@a2a-js/sdk/server";
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from "@a2a-js/sdk/server/express";
import { TaskNotCancelableError } from "@a2a-js/sdk/errors";
import type { ResearchAgents } from "../research/review.js";
import { createDeadline, raceWithAbort } from "../model/deadline.js";
import { ModelError } from "../model/types.js";
import {
  criticInput,
  criticOutput,
  envelope,
  researchInput,
  researchOutput,
  type AgentRole,
} from "./contracts.js";

export function createRoleApp(
  role: AgentRole,
  endpoint: string,
  agents: ResearchAgents,
  timeoutMs: number,
) {
  const card = AgentCard.fromJSON({
    name: `Research Lab ${role}`,
    version: "1.0.0",
    description:
      role === "researcher"
        ? "Draft and revise evidence-grounded reports. No retrieval tools."
        : "Read-only evidence review. No retrieval tools.",
    supportedInterfaces: [
      {
        url: `${endpoint}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: { streaming: true, pushNotifications: false },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: [
      {
        id: role,
        name: role,
        description:
          "Research Lab handoff v1 in a data part: {version:1,input:{question,sources,...}}",
        tags: [role],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  });
  const active = new Map<
    string,
    { cancel: () => void; contextId: string; done: boolean }
  >();
  const status = (
    bus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    state: TaskState,
    text: string,
  ) => {
    bus.publish(
      AgentEvent.statusUpdate(
        TaskStatusUpdateEvent.fromJSON({
          taskId,
          contextId,
          status: {
            state,
            timestamp: new Date().toISOString(),
            message: {
              messageId: randomUUID(),
              taskId,
              contextId,
              role: Role.ROLE_AGENT,
              parts: [
                {
                  text,
                  mediaType: "text/plain",
                },
              ],
            },
          },
        }),
      ),
    );
  };
  const executor: AgentExecutor = {
    async execute(context, bus) {
      const { taskId, contextId } = context;
      bus.publish(
        AgentEvent.task(
          Task.fromJSON({
            id: taskId,
            contextId,
            status: {
              state: TaskState.TASK_STATE_SUBMITTED,
              timestamp: new Date().toISOString(),
            },
            history: [Message.toJSON(context.userMessage)],
          }),
        ),
      );
      const deadline = createDeadline(new AbortController().signal, timeoutMs);
      const record = { cancel: deadline.cancel, contextId, done: false };
      active.set(taskId, record);
      try {
        if (
          context.task ||
          context.userMessage.role !== Role.ROLE_USER ||
          context.userMessage.parts.length !== 1
        )
          throw new Error("Unsupported handoff");
        const part = context.userMessage.parts[0]!;
        if (
          part.content?.$case !== "data" ||
          part.mediaType !== "application/json"
        )
          throw new Error("Data part required");
        const payload = envelope.parse(part.content.value);
        status(
          bus,
          taskId,
          contextId,
          TaskState.TASK_STATE_WORKING,
          `${role} 已接收证据，正在处理。`,
        );
        const output =
          role === "researcher"
            ? researchOutput.parse({
                report: await raceWithAbort(
                  agents.research(
                    researchInput.parse(payload.input),
                    deadline.signal,
                  ),
                  deadline.signal,
                ),
              })
            : criticOutput.parse(
                await raceWithAbort(
                  agents.critique(
                    criticInput.parse(payload.input),
                    deadline.signal,
                  ),
                  deadline.signal,
                ),
              );
        deadline.signal.throwIfAborted();
        record.done = true;
        bus.publish(
          AgentEvent.artifactUpdate(
            TaskArtifactUpdateEvent.fromJSON({
              taskId,
              contextId,
              artifact: {
                artifactId: randomUUID(),
                name: role === "researcher" ? "draft" : "review",
                parts: [
                  {
                    data: output,
                    mediaType: "application/json",
                  },
                ],
              },
              lastChunk: true,
            }),
          ),
        );
        status(
          bus,
          taskId,
          contextId,
          TaskState.TASK_STATE_COMPLETED,
          `${role} 已完成。`,
        );
      } catch {
        if (!record.done) {
          record.done = true;
          const reason: unknown = deadline.signal.reason;
          status(
            bus,
            taskId,
            contextId,
            TaskState.TASK_STATE_FAILED,
            reason instanceof ModelError && reason.code === "MODEL_TIMEOUT"
              ? "AGENT_TIMEOUT：远程角色超过执行时限。"
              : "AGENT_FAILED：输入、模型或产物校验失败。",
          );
        }
      } finally {
        deadline.dispose();
        active.delete(taskId);
        bus.finished();
      }
    },
    async cancelTask(taskId, bus) {
      const record = active.get(taskId);
      if (!record || record.done)
        throw new TaskNotCancelableError("Task is no longer running.");
      record.done = true;
      record.cancel();
      status(
        bus,
        taskId,
        record.contextId,
        TaskState.TASK_STATE_CANCELED,
        "远程任务已取消。",
      );
      bus.finished();
    },
  };
  const handler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    executor,
  );
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    if (req.headers.origin || req.headers.host !== new URL(endpoint).host) {
      res.status(403).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  app.use(
    "/.well-known/agent-card.json",
    agentCardHandler({ agentCardProvider: handler }),
  );
  app.use(
    "/a2a",
    jsonRpcHandler({
      requestHandler: handler,
      userBuilder: UserBuilder.noAuthentication,
    }),
  );
  return {
    app,
    card,
    cancelAll() {
      for (const record of active.values()) record.cancel();
    },
  };
}
