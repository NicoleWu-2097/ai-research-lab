import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { ToolRegistry } from "./tools.js";
import type {
  ArtifactRecord,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from "./types.js";

/**
 * Safely resolves a target path within workspaceRoot and prevents path traversal or symlink escapes.
 */
export async function resolveWorkspacePath(
  workspaceRoot: string,
  targetPath: string,
): Promise<{
  resolvedPath: string;
  relativePath: string;
  canonicalRoot: string;
}> {
  if (!targetPath || targetPath.includes("\0")) {
    throw new Error("Invalid file path.");
  }
  await mkdir(workspaceRoot, { recursive: true });
  const canonicalRoot = await realpath(workspaceRoot);
  const cleanedTarget = targetPath.trim();
  const candidate = isAbsolute(cleanedTarget)
    ? resolve(cleanedTarget)
    : resolve(canonicalRoot, cleanedTarget);

  const relFromCandidate = relative(canonicalRoot, candidate);
  if (
    relFromCandidate.startsWith("..") ||
    isAbsolute(relFromCandidate) ||
    relFromCandidate.split(sep).includes("..")
  ) {
    const err = new Error(
      `Path traversal forbidden: "${targetPath}" is outside workspace root "${canonicalRoot}".`,
    );
    (err as Error & { code: string }).code = "PERMISSION_DENIED";
    throw err;
  }

  // Verify existing parent directory realpath to block symlink escapes
  let current = candidate;
  while (current !== canonicalRoot) {
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink()) {
        const realTarget = await realpath(current);
        const relReal = relative(canonicalRoot, realTarget);
        if (relReal.startsWith("..") || isAbsolute(relReal)) {
          const err = new Error(
            `Symlink escape forbidden: "${targetPath}" points outside workspace root.`,
          );
          (err as Error & { code: string }).code = "PERMISSION_DENIED";
          throw err;
        }
      }
      break;
    } catch (e) {
      if ((e as { code?: string }).code === "PERMISSION_DENIED") throw e;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  return {
    resolvedPath: candidate,
    relativePath: relFromCandidate || ".",
    canonicalRoot,
  };
}

export function computeDiffSummary(before: string, after: string): string {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  let added = 0;
  let removed = 0;
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);
  for (const line of afterLines) {
    if (!beforeSet.has(line)) added++;
  }
  for (const line of beforeLines) {
    if (!afterSet.has(line)) removed++;
  }
  return `+${added} / -${removed} lines (${beforeLines.length} -> ${afterLines.length} lines)`;
}

export function inferArtifactKind(
  filePath: string,
): ArtifactRecord["kind"] {
  if (/\.md$/i.test(filePath)) {
    return /note/i.test(filePath) ? "research_note" : "markdown_report";
  }
  if (/\.(ts|tsx|js|jsx|py|sh|sql|css|html)$/i.test(filePath)) return "code";
  if (/\.(json|csv|yaml|yml|toml)$/i.test(filePath)) return "data";
  return "file";
}

export interface WorkspaceToolsOptions {
  onArtifactCreated?: (artifact: ArtifactRecord) => void | Promise<void>;
  maxFileSizeBytes?: number;
}

export function createWorkspaceTools(
  options: WorkspaceToolsOptions = {},
): ToolDefinition<never, unknown>[] {
  const maxBytes = options.maxFileSizeBytes ?? 512_000;

  const readFileTool: ToolDefinition<
    { path: string; startLine?: number; endLine?: number },
    {
      path: string;
      relativePath: string;
      content: string;
      totalLines: number;
      sha256: string;
      sizeBytes: number;
    }
  > = {
    name: "read_file",
    description:
      "Read a text file within the project workspace. Supports optional 1-based startLine and endLine.",
    inputSchema: z.object({
      path: z.string().trim().min(1).max(1000),
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    outputSchema: z.object({
      path: z.string(),
      relativePath: z.string(),
      content: z.string(),
      totalLines: z.number().int(),
      sha256: z.string(),
      sizeBytes: z.number().int(),
    }),
    permission: "read",
    timeoutMs: 10_000,
    errorTypes: ["permission_error", "tool_error"],
    retryable: false,
    sideEffects: false,
    cancellable: true,
    async execute(
      input,
      context: ToolExecutionContext,
    ): Promise<
      ToolResult<{
        path: string;
        relativePath: string;
        content: string;
        totalLines: number;
        sha256: string;
        sizeBytes: number;
      }>
    > {
      const { resolvedPath, relativePath } = await resolveWorkspacePath(
        context.workspaceRoot,
        input.path,
      );
      const fileStat = await stat(resolvedPath);
      if (!fileStat.isFile()) {
        return {
          success: false,
          error: {
            code: "NOT_A_FILE",
            message: `Path "${relativePath}" is not a regular file.`,
            retryable: false,
            category: "tool_error",
          },
        };
      }
      if (fileStat.size > maxBytes) {
        return {
          success: false,
          error: {
            code: "FILE_TOO_LARGE",
            message: `File "${relativePath}" exceeds maximum size limit (${maxBytes} bytes).`,
            retryable: false,
            category: "tool_error",
          },
        };
      }
      const rawBuffer = await readFile(resolvedPath);
      const fullContent = rawBuffer.toString("utf8");
      const sha256 = createHash("sha256").update(rawBuffer).digest("hex");
      const lines = fullContent.split("\n");
      const start = input.startLine ? Math.max(1, input.startLine) - 1 : 0;
      const end = input.endLine
        ? Math.min(lines.length, input.endLine)
        : lines.length;
      const content = lines.slice(start, end).join("\n");

      return {
        success: true,
        data: {
          path: resolvedPath,
          relativePath,
          content,
          totalLines: lines.length,
          sha256,
          sizeBytes: rawBuffer.byteLength,
        },
      };
    },
  };

  const writeFileTool: ToolDefinition<
    {
      path: string;
      content: string;
      overwrite?: boolean;
      backup?: boolean;
    },
    {
      path: string;
      relativePath: string;
      sha256: string;
      sizeBytes: number;
      verified: boolean;
      backupPath?: string;
      diffSummary: string;
      artifactId: string;
    }
  > = {
    name: "write_file",
    description:
      "Write content to a file in the workspace, verify the written file on disk, and return its real path and SHA-256.",
    inputSchema: z.object({
      path: z.string().trim().min(1).max(1000),
      content: z.string().max(maxBytes),
      overwrite: z.boolean().default(true),
      backup: z.boolean().default(false),
    }),
    outputSchema: z.object({
      path: z.string(),
      relativePath: z.string(),
      sha256: z.string(),
      sizeBytes: z.number().int(),
      verified: z.boolean(),
      backupPath: z.string().optional(),
      diffSummary: z.string(),
      artifactId: z.string(),
    }),
    permission: "write",
    timeoutMs: 10_000,
    errorTypes: ["permission_error", "tool_error"],
    retryable: false,
    sideEffects: true,
    cancellable: true,
    async execute(input, context) {
      const { resolvedPath, relativePath } = await resolveWorkspacePath(
        context.workspaceRoot,
        input.path,
      );

      let existingContent = "";
      let fileExists = false;
      try {
        const st = await stat(resolvedPath);
        if (st.isDirectory()) {
          return {
            success: false,
            error: {
              code: "IS_A_DIRECTORY",
              message: `Cannot write file: "${relativePath}" is a directory.`,
              retryable: false,
              category: "tool_error",
            },
          };
        }
        fileExists = true;
        existingContent = await readFile(resolvedPath, "utf8");
      } catch {
        // file does not exist yet
      }

      if (fileExists && input.overwrite === false) {
        return {
          success: false,
          error: {
            code: "FILE_ALREADY_EXISTS",
            message: `File "${relativePath}" already exists and overwrite=false.`,
            retryable: false,
            category: "permission_error",
          },
        };
      }

      let backupPath: string | undefined;
      if (fileExists && input.backup) {
        backupPath = `${resolvedPath}.bak`;
        await copyFile(resolvedPath, backupPath);
      }

      await mkdir(dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, input.content, "utf8");

      // Mandatory post-write verification on disk
      const verifiedBuffer = await readFile(resolvedPath);
      const verifiedText = verifiedBuffer.toString("utf8");
      const expectedSha256 = createHash("sha256")
        .update(Buffer.from(input.content, "utf8"))
        .digest("hex");
      const actualSha256 = createHash("sha256")
        .update(verifiedBuffer)
        .digest("hex");

      if (verifiedText !== input.content || actualSha256 !== expectedSha256) {
        return {
          success: false,
          error: {
            code: "WRITE_VERIFICATION_FAILED",
            message: `Post-write verification failed for "${relativePath}".`,
            retryable: true,
            category: "tool_error",
          },
        };
      }

      const diffSummary = computeDiffSummary(existingContent, verifiedText);
      const now = new Date().toISOString();
      const artifact: ArtifactRecord = {
        id: randomUUID(),
        taskId: context.taskId,
        projectId: context.projectId,
        path: resolvedPath,
        relativePath,
        kind: inferArtifactKind(relativePath),
        sha256: actualSha256,
        sizeBytes: verifiedBuffer.byteLength,
        createdAt: now,
        updatedAt: now,
        contentPreview: verifiedText.slice(0, 500),
        diffSummary,
      };

      await options.onArtifactCreated?.(artifact);
      await context.emit?.(
        "artifact_created",
        `已写入并校验文件：${relativePath} (${verifiedBuffer.byteLength} bytes)`,
        {
          artifact,
        },
      );

      return {
        success: true,
        data: {
          path: resolvedPath,
          relativePath,
          sha256: actualSha256,
          sizeBytes: verifiedBuffer.byteLength,
          verified: true,
          ...(backupPath ? { backupPath } : {}),
          diffSummary,
          artifactId: artifact.id,
        },
      };
    },
  };

  const editFileTool: ToolDefinition<
    {
      path: string;
      target: string;
      replacement: string;
      backup?: boolean;
    },
    {
      path: string;
      relativePath: string;
      sha256: string;
      sizeBytes: number;
      verified: boolean;
      diffSummary: string;
      artifactId: string;
    }
  > = {
    name: "edit_file",
    description:
      "Edit an existing file by replacing target text with replacement text, verifying the result on disk.",
    inputSchema: z.object({
      path: z.string().trim().min(1).max(1000),
      target: z.string().min(1),
      replacement: z.string(),
      backup: z.boolean().default(false),
    }),
    outputSchema: z.object({
      path: z.string(),
      relativePath: z.string(),
      sha256: z.string(),
      sizeBytes: z.number().int(),
      verified: z.boolean(),
      diffSummary: z.string(),
      artifactId: z.string(),
    }),
    permission: "write",
    timeoutMs: 10_000,
    errorTypes: ["permission_error", "tool_error"],
    retryable: false,
    sideEffects: true,
    cancellable: true,
    async execute(input, context) {
      const { resolvedPath, relativePath } = await resolveWorkspacePath(
        context.workspaceRoot,
        input.path,
      );
      const original = await readFile(resolvedPath, "utf8");
      if (!original.includes(input.target)) {
        return {
          success: false,
          error: {
            code: "TARGET_NOT_FOUND",
            message: `Target string was not found in "${relativePath}".`,
            retryable: true,
            category: "tool_error",
          },
        };
      }

      if (input.backup) {
        await copyFile(resolvedPath, `${resolvedPath}.bak`);
      }

      const updated = original.replaceAll(input.target, input.replacement);
      await writeFile(resolvedPath, updated, "utf8");

      const verifiedBuffer = await readFile(resolvedPath);
      const verifiedText = verifiedBuffer.toString("utf8");
      const sha256 = createHash("sha256")
        .update(verifiedBuffer)
        .digest("hex");

      if (verifiedText !== updated) {
        return {
          success: false,
          error: {
            code: "EDIT_VERIFICATION_FAILED",
            message: `Post-edit verification failed for "${relativePath}".`,
            retryable: true,
            category: "tool_error",
          },
        };
      }

      const diffSummary = computeDiffSummary(original, verifiedText);
      const now = new Date().toISOString();
      const artifact: ArtifactRecord = {
        id: randomUUID(),
        taskId: context.taskId,
        projectId: context.projectId,
        path: resolvedPath,
        relativePath,
        kind: inferArtifactKind(relativePath),
        sha256,
        sizeBytes: verifiedBuffer.byteLength,
        createdAt: now,
        updatedAt: now,
        contentPreview: verifiedText.slice(0, 500),
        diffSummary,
      };

      await options.onArtifactCreated?.(artifact);
      await context.emit?.(
        "artifact_created",
        `已修改并校验文件：${relativePath} (${diffSummary})`,
        {
          artifact,
        },
      );

      return {
        success: true,
        data: {
          path: resolvedPath,
          relativePath,
          sha256,
          sizeBytes: verifiedBuffer.byteLength,
          verified: true,
          diffSummary,
          artifactId: artifact.id,
        },
      };
    },
  };

  const listDirectoryTool: ToolDefinition<
    { path?: string },
    {
      path: string;
      relativePath: string;
      entries: Array<{
        name: string;
        type: "file" | "directory" | "other";
        sizeBytes?: number;
      }>;
    }
  > = {
    name: "list_directory",
    description: "List files and directories inside a workspace directory.",
    inputSchema: z.object({
      path: z.string().trim().default("."),
    }),
    outputSchema: z.object({
      path: z.string(),
      relativePath: z.string(),
      entries: z.array(
        z.object({
          name: z.string(),
          type: z.enum(["file", "directory", "other"]),
          sizeBytes: z.number().int().optional(),
        }),
      ),
    }),
    permission: "read",
    timeoutMs: 10_000,
    errorTypes: ["permission_error", "tool_error"],
    retryable: false,
    sideEffects: false,
    cancellable: true,
    async execute(input, context) {
      const { resolvedPath, relativePath } = await resolveWorkspacePath(
        context.workspaceRoot,
        input.path || ".",
      );
      const dirEntries = await readdir(resolvedPath, { withFileTypes: true });
      const entries = await Promise.all(
        dirEntries
          .filter((e) => !e.name.startsWith(".git") && e.name !== "node_modules")
          .slice(0, 100)
          .map(async (entry) => {
            const type: "file" | "directory" | "other" = entry.isFile()
              ? "file"
              : entry.isDirectory()
                ? "directory"
                : "other";
            let sizeBytes: number | undefined;
            if (type === "file") {
              try {
                const st = await stat(join(resolvedPath, entry.name));
                sizeBytes = st.size;
              } catch {
                // ignore stat error
              }
            }
            return {
              name: entry.name,
              type,
              ...(sizeBytes !== undefined ? { sizeBytes } : {}),
            };
          }),
      );
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return {
        success: true,
        data: {
          path: resolvedPath,
          relativePath,
          entries,
        },
      };
    },
  };

  const searchFilesTool: ToolDefinition<
    { query: string; path?: string; maxResults?: number },
    {
      matches: Array<{
        relativePath: string;
        line: number;
        snippet: string;
      }>;
    }
  > = {
    name: "search_files",
    description:
      "Search for text or filenames across files in the project workspace.",
    inputSchema: z.object({
      query: z.string().trim().min(1).max(300),
      path: z.string().trim().default("."),
      maxResults: z.number().int().min(1).max(50).default(20),
    }),
    outputSchema: z.object({
      matches: z.array(
        z.object({
          relativePath: z.string(),
          line: z.number().int(),
          snippet: z.string(),
        }),
      ),
    }),
    permission: "read",
    timeoutMs: 10_000,
    errorTypes: ["permission_error", "tool_error"],
    retryable: false,
    sideEffects: false,
    cancellable: true,
    async execute(input, context) {
      const { resolvedPath, canonicalRoot } = await resolveWorkspacePath(
        context.workspaceRoot,
        input.path || ".",
      );
      const matches: Array<{
        relativePath: string;
        line: number;
        snippet: string;
      }> = [];
      const needle = input.query.toLowerCase();

      async function walk(dir: string, depth: number) {
        if (depth > 5 || matches.length >= input.maxResults!) return;
        let items;
        try {
          items = await readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const item of items) {
          if (matches.length >= input.maxResults!) break;
          if (
            item.name.startsWith(".") ||
            item.name === "node_modules" ||
            item.name === "dist"
          )
            continue;
          const full = join(dir, item.name);
          if (item.isDirectory()) {
            await walk(full, depth + 1);
          } else if (
            item.isFile() &&
            /\.(md|txt|ts|tsx|js|json|yaml|yml|css|html)$/i.test(item.name)
          ) {
            try {
              const st = await stat(full);
              if (st.size > 200_000) continue;
              const text = await readFile(full, "utf8");
              const rel = relative(canonicalRoot, full);
              if (item.name.toLowerCase().includes(needle)) {
                matches.push({
                  relativePath: rel,
                  line: 1,
                  snippet: `[Filename match] ${rel}`,
                });
              }
              const lines = text.split("\n");
              for (let i = 0; i < lines.length; i++) {
                if (lines[i]!.toLowerCase().includes(needle)) {
                  matches.push({
                    relativePath: rel,
                    line: i + 1,
                    snippet: lines[i]!.trim().slice(0, 200),
                  });
                  if (matches.length >= input.maxResults!) break;
                }
              }
            } catch {
              // ignore unreadable files
            }
          }
        }
      }

      await walk(resolvedPath, 0);
      return {
        success: true,
        data: { matches },
      };
    },
  };

  const createDirectoryTool: ToolDefinition<
    { path: string },
    { path: string; relativePath: string; created: boolean }
  > = {
    name: "create_directory",
    description: "Create a directory (and any necessary parent directories) in the workspace.",
    inputSchema: z.object({
      path: z.string().trim().min(1).max(1000),
    }),
    outputSchema: z.object({
      path: z.string(),
      relativePath: z.string(),
      created: z.boolean(),
    }),
    permission: "write",
    timeoutMs: 10_000,
    errorTypes: ["permission_error", "tool_error"],
    retryable: false,
    sideEffects: true,
    cancellable: true,
    async execute(input, context) {
      const { resolvedPath, relativePath } = await resolveWorkspacePath(
        context.workspaceRoot,
        input.path,
      );
      await mkdir(resolvedPath, { recursive: true });
      const st = await stat(resolvedPath);
      if (!st.isDirectory()) {
        return {
          success: false,
          error: {
            code: "CREATE_DIRECTORY_FAILED",
            message: `Failed to verify directory creation at "${relativePath}".`,
            retryable: false,
            category: "tool_error",
          },
        };
      }
      return {
        success: true,
        data: {
          path: resolvedPath,
          relativePath,
          created: true,
        },
      };
    },
  };

  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirectoryTool,
    searchFilesTool,
    createDirectoryTool,
  ] as unknown as ToolDefinition<never, unknown>[];
}

export function registerWorkspaceTools(
  registry: ToolRegistry,
  options: WorkspaceToolsOptions = {},
): ToolRegistry {
  for (const tool of createWorkspaceTools(options)) {
    registry.register(tool);
  }
  return registry;
}
