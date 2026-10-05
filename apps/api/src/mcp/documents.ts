import { constants } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";

export const documentIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/)
  .max(160);
export const sourceSchema = z.object({
  id: documentIdSchema,
  content: z.string().max(24_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  retrievedAt: z.iso.datetime(),
});
export type DocumentSource = z.infer<typeof sourceSchema>;

export async function listDocuments(root: string): Promise<string[]> {
  const entries = await readdir(await realpath(root), { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && documentIdSchema.safeParse(entry.name).success,
    )
    .map((entry) => entry.name)
    .sort()
    .slice(0, 30);
}

export async function readDocument(
  root: string,
  id: string,
): Promise<DocumentSource> {
  documentIdSchema.parse(id);
  const directory = await realpath(root);
  // O_NOFOLLOW rejects symlinks even if a listed file is replaced before opening.
  const file = await open(
    join(directory, id),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 24_000)
      throw new Error("Document is not a small regular file.");
    const bytes = Buffer.alloc(24_001);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 24_000) throw new Error("Document is too large.");
    const data = bytes.subarray(0, bytesRead);
    return {
      id,
      content: data.toString("utf8"),
      sha256: createHash("sha256").update(data).digest("hex"),
      retrievedAt: new Date().toISOString(),
    };
  } finally {
    await file.close();
  }
}
