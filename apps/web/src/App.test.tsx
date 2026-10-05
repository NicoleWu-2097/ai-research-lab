// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("API status page", () => {
  it("shows the API as online after a healthy response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "ok", service: "api" }), {
          status: 200,
        }),
      ),
    );

    render(<App />);

    expect((await screen.findByText("API online")).textContent).toBe(
      "API online",
    );
  });

  it("shows the API as unavailable when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("connection refused")),
    );

    render(<App />);

    expect((await screen.findByText("API unavailable")).textContent).toBe(
      "API unavailable",
    );
  });
});
