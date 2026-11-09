import { useEffect, useState } from "react";
import { HumanResearch } from "./HumanResearch";
import { ResearchForm } from "./ResearchForm";

type HealthState = "checking" | "online" | "offline";

export function App() {
  const [health, setHealth] = useState<HealthState>("checking");

  const [human, setHuman] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function checkHealth() {
      try {
        const response = await fetch("/api/health", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body: unknown = await response.json();
        const isHealthy =
          typeof body === "object" &&
          body !== null &&
          "status" in body &&
          body.status === "ok";
        setHealth(isHealthy ? "online" : "offline");
        setHuman(
          isHealthy &&
            "humanEnabled" in (body as object) &&
            (body as { humanEnabled?: boolean }).humanEnabled === true,
        );
      } catch {
        if (!controller.signal.aborted) setHealth("offline");
      }
    }

    void checkHealth();
    return () => controller.abort();
  }, []);

  const label = {
    checking: "Checking API…",
    online: "API online",
    offline: "API unavailable",
  }[health];

  return (
    <main className="terminal-shell">
      <header className="app-header">
        <div className="wordmark">
          <span aria-hidden="true">▣</span>
          <h1>AI Research Lab</h1>
          <span className="version">/ research workspace</span>
        </div>
        <p role="status" data-state={health}>
          <span className="status-dot" />
          {label}
        </p>
      </header>
      <div className="workspace-path">
        <span>~/ai-research-lab</span>
        <span>{human ? "审批模式 · durable" : "即时研究 · stream"}</span>
      </div>
      {human ? <HumanResearch /> : <ResearchForm />}
    </main>
  );
}
