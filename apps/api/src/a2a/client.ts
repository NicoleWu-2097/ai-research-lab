import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { SendMessageRequest, TaskState, type Task } from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import type { ResearchAgents } from "../research/review.js";
import type { ToolEventSink } from "../mcp/client.js";
import { raceWithAbort } from "../model/deadline.js";
import {
  criticOutput,
  localEndpoint,
  researchOutput,
  terminal,
  type AgentRole,
} from "./contracts.js";

export class AgentTransportError extends Error {
  readonly code = "A2A_FAILED";
  constructor() {
    super("A2A 角色调用失败；未发布未经验证的产物。");
  }
}
export interface AgentEndpoints {
  researcher: string;
  critic: string;
}
export function readAgentEndpoints(
  env: NodeJS.ProcessEnv,
): AgentEndpoints | null {
  if (
    env.A2A_ENABLED !== undefined &&
    !["true", "false"].includes(env.A2A_ENABLED)
  )
    throw new Error("A2A_ENABLED must be true or false.");
  if (env.A2A_ENABLED !== "true") return null;
  if (
    env.AGENTIC_RAG_ENABLED === "false" ||
    env.MULTI_AGENT_ENABLED === "false"
  )
    throw new Error("A2A requires Agentic RAG and multi-agent review.");
  return {
    researcher: localEndpoint(
      env.A2A_RESEARCHER_URL ?? "http://127.0.0.1:4101",
    ),
    critic: localEndpoint(env.A2A_CRITIC_URL ?? "http://127.0.0.1:4102"),
  };
}

export function createRemoteAgents(
  endpoints: AgentEndpoints,
  emit: ToolEventSink,
  fetchImpl: typeof fetch = fetch,
): ResearchAgents {
  async function call(
    role: AgentRole,
    input: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const endpoint = localEndpoint(endpoints[role]);
    let client: Client | undefined;
    let taskId: string | undefined;
    let ended = false;
    const read = async <T>(operation: () => Promise<T>): Promise<T> => {
      try {
        return await raceWithAbort(operation(), signal);
      } catch {
        signal.throwIfAborted();
        await emit("A2A_RETRY", {
          agent: role,
          message: `A2A ${role}：只读请求重试一次。`,
        });
        return raceWithAbort(operation(), signal);
      }
    };
    try {
      signal.throwIfAborted();
      const guardedFetch: typeof fetch = (url, init) => {
        if (
          new URL(url instanceof Request ? url.url : url.toString()).origin !==
          endpoint
        )
          throw new AgentTransportError();
        return fetchImpl(url, { ...init, redirect: "error" });
      };
      const resolver = new DefaultAgentCardResolver({
        fetchImpl: (url, init) => guardedFetch(url, { ...init, signal }),
      });
      const card = await read(() => resolver.resolve(endpoint));
      const binding = card.supportedInterfaces.find(
        (i) =>
          i.protocolBinding === "JSONRPC" &&
          i.protocolVersion === "1.0" &&
          i.url === `${endpoint}/a2a`,
      );
      if (
        !binding ||
        !card.capabilities?.streaming ||
        !card.skills.some((s) => s.id === role) ||
        !card.defaultInputModes.includes("application/json") ||
        !card.defaultOutputModes.includes("application/json")
      )
        throw new AgentTransportError();
      // Never follow a discovered card to an unconfigured destination or transport.
      client = await new ClientFactory({
        transports: [new JsonRpcTransportFactory({ fetchImpl: guardedFetch })],
      }).createFromAgentCard({ ...card, supportedInterfaces: [binding] });
      await emit("A2A_DISCOVERED", {
        agent: role,
        endpoint,
        message: `A2A 已发现 ${role}（协议 1.0，JSON-RPC）。`,
      });
      const request = SendMessageRequest.fromJSON({
        message: {
          messageId: randomUUID(),
          role: 1,
          parts: [
            {
              mediaType: "application/json",
              data: { version: 1, input },
            },
          ],
        },
      });
      let state: TaskState | undefined;
      try {
        for await (const event of client.sendMessageStream(request, {
          signal,
        })) {
          const payload = event.payload;
          if (!payload) throw new AgentTransportError();
          if (payload.$case === "task") {
            if (taskId && taskId !== payload.value.id)
              throw new AgentTransportError();
            taskId = payload.value.id;
            state = payload.value.status?.state;
            await emit("A2A_TASK_CREATED", {
              agent: role,
              remoteTaskId: taskId,
              message: `A2A ${role}：任务 ${taskId} 已创建。`,
            });
          } else if (
            payload.$case === "statusUpdate" ||
            payload.$case === "artifactUpdate"
          ) {
            if (!taskId || payload.value.taskId !== taskId)
              throw new AgentTransportError();
            if (payload.$case === "statusUpdate") {
              state = payload.value.status?.state;
              await emit("A2A_PROGRESS", {
                agent: role,
                remoteTaskId: taskId,
                state,
                message: `A2A ${role}：${TaskState[state ?? 0]}`,
              });
            } else {
              await emit("A2A_ARTIFACT", {
                agent: role,
                remoteTaskId: taskId,
                message: `A2A ${role}：收到产物，等待终态与契约校验。`,
              });
            }
          } else throw new AgentTransportError();
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!taskId || error instanceof AgentTransportError) throw error;
        await emit("A2A_RETRY", {
          agent: role,
          remoteTaskId: taskId,
          message: `A2A ${role}：流中断，查询同一任务；不重复提交。`,
        });
      }
      if (!taskId) throw new AgentTransportError();
      // A GetTask snapshot recovers missed artifacts and terminal events without replaying SendMessage.
      let task: Task;
      do {
        task = await read(() =>
          client!.getTask(
            { id: taskId!, tenant: "", historyLength: 0 },
            { signal },
          ),
        );
        if (task.id !== taskId) throw new AgentTransportError();
        state = task.status?.state;
        if (state !== undefined && terminal.has(state)) break;
        if (
          state !== TaskState.TASK_STATE_WORKING &&
          state !== TaskState.TASK_STATE_SUBMITTED
        )
          throw new AgentTransportError();
        await delay(200, undefined, { signal });
      } while (!terminal.has(state));
      ended = true;
      if (
        state !== TaskState.TASK_STATE_COMPLETED ||
        task.artifacts.length !== 1
      )
        throw new AgentTransportError();
      const parts = task.artifacts[0]!.parts;
      if (
        parts.length !== 1 ||
        parts[0]!.content?.$case !== "data" ||
        parts[0]!.mediaType !== "application/json"
      )
        throw new AgentTransportError();
      const data: unknown = parts[0]!.content.value;
      const output =
        role === "researcher"
          ? researchOutput.parse(data)
          : criticOutput.parse(data);
      await emit("A2A_COMPLETED", {
        agent: role,
        remoteTaskId: taskId,
        message: `A2A ${role}：终态和产物已校验。`,
      });
      return output;
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new AgentTransportError();
    } finally {
      if (client && taskId && !ended) {
        // Cancellation uses a separate short deadline: the original signal may already be aborted.
        await client
          .cancelTask(
            { id: taskId, tenant: "", metadata: undefined },
            { signal: AbortSignal.timeout(1500) },
          )
          .catch(() => undefined);
      }
    }
  }
  return {
    async research(input, signal) {
      const { report } = researchOutput.parse(
        await call("researcher", input, signal),
      );
      const ids = [...report.matchAll(/\[(RAG:[^\]]+)\]/g)].map((m) => m[1]!);
      if (
        !ids.length ||
        ids.some((id) => !input.sources.some((s) => s.id === id))
      )
        throw new AgentTransportError();
      return report;
    },
    async critique(input, signal) {
      return criticOutput.parse(await call("critic", input, signal));
    },
  };
}
