export interface ResearchEvent {
  taskId: string;
  sequence: number;
  type: string;
  text?: string;
  report?: string;
  message?: string;
}

export async function readResearchStream(
  response: Response,
  onEvent: (event: ResearchEvent) => void,
) {
  if (!response.body) throw new Error("The server returned no stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event: unknown = JSON.parse(data);
        if (
          typeof event !== "object" ||
          event === null ||
          !("taskId" in event) ||
          typeof event.taskId !== "string" ||
          !("sequence" in event) ||
          typeof event.sequence !== "number" ||
          !("type" in event) ||
          typeof event.type !== "string"
        )
          throw new Error("Invalid research event.");
        const record = event as Record<string, unknown>;
        for (const field of ["text", "report", "message"] as const) {
          if (field in record && typeof record[field] !== "string")
            throw new Error("Invalid research event payload.");
        }
        const parsed = event as ResearchEvent;
        onEvent(parsed);
        terminal ||= [
          "AGENT_COMPLETED",
          "AGENT_FAILED",
          "TASK_CANCELLED",
        ].includes(parsed.type);
      }
      if (done) break;
    }
    if (!terminal)
      throw new Error("The research stream ended before completion.");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
