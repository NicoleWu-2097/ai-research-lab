import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { raceWithAbort } from "../model/deadline.js";
import { ModelError, type ModelProvider } from "../model/types.js";

const State = Annotation.Root({
  question: Annotation<string>(),
  report: Annotation<string>(),
});

export async function runResearch(
  question: string,
  provider: ModelProvider,
  signal: AbortSignal,
  onDelta: (text: string) => Promise<void>,
): Promise<string> {
  const graph = new StateGraph(State)
    .addNode("research", async (state) => {
      const prompt = [
        "You are a research assistant producing a preliminary analysis from model knowledge only.",
        "You have no search tools or retrieved evidence. Do not invent citations or claim to have searched.",
        "Use the question's language. Include: preliminary conclusion, reasoning, uncertainties, and what evidence to seek next.",
        "Research question:",
        state.question,
      ].join("\n\n");
      const output = provider.stream(prompt, signal);
      const iterator = output[Symbol.asyncIterator]();
      let report = "";
      try {
        while (true) {
          const next = await raceWithAbort(iterator.next(), signal);
          if (next.done) break;
          signal.throwIfAborted();
          report += next.value;
          await onDelta(next.value);
        }
      } finally {
        void iterator.return?.().catch(() => undefined);
      }
      if (!report.trim())
        throw new ModelError(
          "MODEL_INVALID_OUTPUT",
          "The model returned no report.",
        );
      return { report };
    })
    .addEdge(START, "research")
    .addEdge("research", END)
    .compile();

  const result = await raceWithAbort(
    graph.invoke({ question, report: "" }, { signal }),
    signal,
  );
  return result.report;
}
