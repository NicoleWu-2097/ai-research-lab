import { useEffect, useState } from "react";
import { ResearchForm } from "./ResearchForm";

type HealthState = "checking" | "online" | "offline";

export function App() {
  const [health, setHealth] = useState<HealthState>("checking");

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
    <main>
      <h1>AI Research Lab</h1>
      <p>Research Agent</p>
      <p role="status" data-state={health}>
        {label}
      </p>
      <ResearchForm />
    </main>
  );
}
