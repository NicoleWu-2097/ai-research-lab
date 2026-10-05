import { describe, expect, it } from "vitest";

import { app } from "../src/app.js";

describe("GET /api/health", () => {
  it("returns a healthy API response", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "api" });
  });
});
