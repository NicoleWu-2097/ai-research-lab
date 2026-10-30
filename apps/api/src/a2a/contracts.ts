import { z } from "zod";
import { reviewSchema } from "../research/review.js";

export type AgentRole = "researcher" | "critic";
export const sourceSchema = z.object({
  id: z.string().regex(/^RAG:[1-8]$/),
  content: z.string().min(1).max(900),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  retrievedAt: z.iso.datetime(),
});
const base = z.object({
  question: z.string().trim().min(1).max(8000),
  sources: z
    .array(sourceSchema)
    .min(1)
    .max(8)
    .refine((s) => new Set(s.map((x) => x.id)).size === s.length),
});
export const researchInput = base.extend({
  revision: z
    .object({
      draft: z.string().min(1).max(32000),
      issues: z.array(z.string().min(1).max(700)).min(1).max(6),
    })
    .nullable(),
});
export const criticInput = base.extend({ draft: z.string().min(1).max(32000) });
export const researchOutput = z.object({
  report: z.string().trim().min(1).max(32000),
});
export const criticOutput = reviewSchema.refine((r) =>
  r.verdict === "approve" ? r.issues.length === 0 : r.issues.length > 0,
);
export const envelope = z
  .object({ version: z.literal(1), input: z.unknown() })
  .strict();
export const terminal = new Set([3, 4, 5, 7]);

export function localEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("A2A endpoints must be http://127.0.0.1:<port> origins.");
  return url.origin;
}
