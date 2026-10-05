import { expect, it } from "vitest";
import { readDatabaseConfig } from "../src/rag/database-config.js";

it("supports local and external PostgreSQL with validated TLS", () => {
  expect(
    readDatabaseConfig({ DATABASE_URL: "postgresql://localhost/research" }),
  ).toEqual({ connectionString: "postgresql://localhost/research" });
  expect(
    readDatabaseConfig({
      DATABASE_URL: "postgres://db.example/research",
      DATABASE_SSL_MODE: "verify-full",
    }).ssl,
  ).toEqual({ rejectUnauthorized: true });
});

it("rejects invalid protocols, conflicting TLS configuration and insecure CA usage", () => {
  expect(() =>
    readDatabaseConfig({ DATABASE_URL: "https://db.example/research" }),
  ).toThrow();
  expect(() =>
    readDatabaseConfig({
      DATABASE_URL: "postgres://db.example/research?sslmode=require",
      DATABASE_SSL_MODE: "verify-full",
    }),
  ).toThrow("either");
  expect(() =>
    readDatabaseConfig({
      DATABASE_URL: "postgres://db.example/research",
      DATABASE_SSL_CA_FILE: "/missing.pem",
    }),
  ).toThrow("requires");
});
