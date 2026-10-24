import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { presentMcpUpload } from "./mcp-document-links.ts";

type McpBundleFile = { path: string; content: string };

export type HostedMcpDocuments = {
  list: (cursor: string | null, limit: number) => Promise<unknown>;
  read: (id: string, offset?: number, maxCharacters?: number, path?: string) => Promise<unknown>;
  upload: (title: string, html: string) => Promise<{ id: string }>;
  listBundleFiles: (id: string, offset?: number, limit?: number) => Promise<unknown>;
  uploadBundle: (
    title: string,
    files: readonly McpBundleFile[]
  ) => Promise<{ id: string; [key: string]: unknown }>;
  delete: (id: string) => Promise<unknown>;
};

// For a 512-file bundle, the arguments contain 1,538 array elements and
// object members: 2 top-level fields, 512 array entries, and 2 fields per file.
// The remaining budget leaves room for ordinary nested metadata while bounding
// adversarial input before schema validation walks it.
export const MCP_MAX_TOOL_INPUT_ELEMENTS = 2048;

const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

const runTool = async (name: string, operation: () => Promise<unknown>) => {
  try {
    return result(await operation());
  } catch (error) {
    console.error("mcp.tool_failed", {
      name,
      errorType: error instanceof Error ? error.name : "UnknownError",
      at: error instanceof Error ? error.stack?.split("\n")[1]?.trim() : undefined,
    });
    throw error;
  }
};

export const createHostedMcpServer = (documents: HostedMcpDocuments, previewBaseUrl: string) => {
  const server = new McpServer(
    { name: "planview-cloud", version: "0.1.0" },
    { maxToolInputElements: MCP_MAX_TOOL_INPUT_ELEMENTS }
  );

  server.registerTool(
    "list_documents",
    {
      description: "List your cloud documents, newest first. Use nextCursor to continue.",
      inputSchema: z.object({
        cursor: z.string().nullable().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ cursor, limit }) =>
      runTool("list_documents", () => documents.list(cursor ?? null, limit ?? 25))
  );

  server.registerTool(
    "read_document",
    {
      description:
        "Read your cloud document in chunks of up to 32768 characters. Bundle reads default to index.html; set path to read a CSS, JavaScript, or other text asset.",
      inputSchema: z.object({
        id: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        maxCharacters: z.number().int().min(1).max(32_768).optional(),
        path: z.string().min(1).max(1024).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, offset, maxCharacters, path }) =>
      runTool("read_document", () => documents.read(id, offset, maxCharacters, path))
  );

  server.registerTool(
    "upload_document",
    {
      description:
        "Upload an HTML document to your cloud workspace. Maximum encoded size is 8 MiB. Uploaded files are public during development.",
      inputSchema: z.object({ title: z.string().min(1).max(200), html: z.string() }),
      annotations: { readOnlyHint: false },
    },
    async ({ title, html }) =>
      runTool("upload_document", async () => {
        const { id } = await documents.upload(title, html);
        return presentMcpUpload(id, previewBaseUrl);
      })
  );

  server.registerTool(
    "list_bundle_files",
    {
      description:
        "List files in your uploaded artifact bundle, up to 50 files per page. Use nextOffset to continue.",
      inputSchema: z.object({
        id: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ id, offset, limit }) =>
      runTool("list_bundle_files", () => documents.listBundleFiles(id, offset, limit))
  );

  server.registerTool(
    "upload_bundle",
    {
      description:
        "Upload an HTML/CSS/JavaScript artifact as one document. Requires root index.html. File paths are relative and URL-safe. Files contain UTF-8 text; at most 512 files and 8 MiB including the manifest. read_document reads its index.html. Each upload creates a new document.",
      inputSchema: z.object({
        title: z.string().min(1).max(200),
        files: z
          .array(z.object({ path: z.string().min(1).max(1024), content: z.string() }))
          .min(1)
          .max(512),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ title, files }) =>
      runTool("upload_bundle", async () => {
        const uploaded = await documents.uploadBundle(title, files);
        return { ...uploaded, ...presentMcpUpload(uploaded.id, previewBaseUrl) };
      })
  );

  server.registerTool(
    "delete_document",
    {
      description:
        "Hide one of your documents immediately and queue storage cleanup with background retries.",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { destructiveHint: true },
    },
    async ({ id }) => runTool("delete_document", () => documents.delete(id))
  );

  return server;
};
