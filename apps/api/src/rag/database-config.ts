import { readFileSync } from "node:fs";
import { z } from "zod";
import type { PoolConfig } from "pg";

export function readDatabaseConfig(env: NodeJS.ProcessEnv): PoolConfig {
  const config = z
    .object({
      DATABASE_URL: z
        .url()
        .refine(
          (value) =>
            ["postgres:", "postgresql:"].includes(new URL(value).protocol),
          "Use a PostgreSQL connection URL.",
        ),
      DATABASE_SSL_MODE: z.enum(["disable", "verify-full"]).optional(),
      DATABASE_SSL_CA_FILE: z.string().min(1).optional(),
    })
    .parse(env);
  if (config.DATABASE_SSL_CA_FILE && config.DATABASE_SSL_MODE !== "verify-full")
    throw new Error(
      "DATABASE_SSL_CA_FILE requires DATABASE_SSL_MODE=verify-full.",
    );
  const url = new URL(config.DATABASE_URL);
  if (
    config.DATABASE_SSL_MODE &&
    ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert"].some((key) =>
      url.searchParams.has(key),
    )
  )
    throw new Error(
      "Configure TLS through either DATABASE_SSL_MODE or URL parameters, not both.",
    );
  return {
    connectionString: config.DATABASE_URL,
    ...(config.DATABASE_SSL_MODE
      ? {
          ssl:
            config.DATABASE_SSL_MODE === "disable"
              ? false
              : {
                  rejectUnauthorized: true,
                  ...(config.DATABASE_SSL_CA_FILE
                    ? { ca: readFileSync(config.DATABASE_SSL_CA_FILE, "utf8") }
                    : {}),
                },
        }
      : {}),
  };
}
