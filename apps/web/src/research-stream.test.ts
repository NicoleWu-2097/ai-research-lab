import { describe, expect, it } from "vitest";
import { readResearchStream, type ResearchEvent } from "./research-stream";

describe("research event stream", () => {
  it("decodes frames and Unicode split across network chunks", async () => {
    const bytes = new TextEncoder().encode(
      'data: {"taskId":"one","sequence":1,"type":"REPORT_DELTA","text":"研究"}\n\ndata: {"taskId":"one","sequence":2,"type":"AGENT_COMPLETED","report":"研究"}\n\n',
    );
    const events: ResearchEvent[] = [];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        controller.close();
      },
    });
    await readResearchStream(new Response(body), (event) => events.push(event));
    expect(events.map((event) => event.type)).toEqual([
      "REPORT_DELTA",
      "AGENT_COMPLETED",
    ]);
    expect(events[0]?.text).toBe("研究");
  });
  it("rejects a stream without a terminal event", async () => {
    await expect(
      readResearchStream(
        new Response(
          'data: {"taskId":"one","sequence":1,"type":"AGENT_STARTED"}\n\n',
        ),
        () => undefined,
      ),
    ).rejects.toThrow("before completion");
  });
});
