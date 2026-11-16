import { existsSync } from "node:fs";
import { createRag } from "./config.js";

type Rag = ReturnType<typeof createRag>;

/** 维护脚本入口：加载 .env，建立 RAG，统一处理中断信号、超时、失败信息与收尾关闭。 */
export async function runRagScript(
  label: string,
  failure: string,
  run: (rag: Rag, signal: AbortSignal) => Promise<void>,
) {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const rag = createRag(process.env);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error(`${label} cancelled.`));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    await run(
      rag,
      AbortSignal.any([controller.signal, AbortSignal.timeout(600_000)]),
    );
  } catch {
    console.error(failure);
    process.exitCode = 1;
  } finally {
    await rag.close();
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
}
