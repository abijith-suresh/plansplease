import assert from "node:assert/strict";
import { test } from "node:test";

import { createMcpHandler } from "@modelcontextprotocol/server";
import { cloudBundleMaxBytes, packCloudBundle } from "@planview/core/cloud-bundle";

import { createHostedMcpServer } from "../src/lib/hosted-mcp-server.ts";

const previewBaseUrl = "https://plans.example";
const maxRequestBodySize = 50 * 1024 * 1024;

const makeDocuments = (
  onUploadBundle: (files: readonly { path: string; content: string }[]) => void
) => ({
  list: async () => ({ documents: [], nextCursor: null }),
  read: async () => null,
  upload: async () => ({ id: "document-id" }),
  listBundleFiles: async () => ({ files: [], nextOffset: null }),
  uploadBundle: async (_title: string, files: readonly { path: string; content: string }[]) => {
    onUploadBundle(files);
    return { id: "document-id", kind: "bundle", fileCount: files.length };
  },
  delete: async () => ({ ok: true }),
});

const callUploadBundle = async (
  documents: ReturnType<typeof makeDocuments>,
  arguments_: unknown
) => {
  const handler = createMcpHandler(() => createHostedMcpServer(documents, previewBaseUrl), {
    legacy: "reject",
    maxRequestBodySize,
  });
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
      name: "upload_bundle",
      arguments: arguments_,
    },
  };
  const response = await handler.fetch(
    new Request("https://plans.example/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": "upload_bundle",
      },
      body: JSON.stringify(body),
    })
  );
  assert.equal(response.status, 200);
  return response.json() as Promise<{
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  }>;
};

test("MCP rejects deeply nested tool input before calling the upload service", async () => {
  let uploadCalls = 0;
  let nested: Record<string, unknown> = {};
  for (let index = 0; index < 2200; index += 1) nested = { child: nested };

  const response = await callUploadBundle(
    makeDocuments(() => (uploadCalls += 1)),
    {
      title: "nested input",
      files: [{ path: "index.html", content: "<h1>ok</h1>", extension: nested }],
    }
  );

  assert.equal(response.result?.isError, true);
  assert.match(response.result?.content?.[0]?.text ?? "", /maximum of 2048 elements/);
  assert.equal(uploadCalls, 0);
});

test("MCP accepts a valid 512-file bundle close to the 8 MiB encoded limit", async () => {
  let packedBytes = 0;
  let uploadedFileCount = 0;
  const files = [
    { path: "index.html", content: "x".repeat(cloudBundleMaxBytes - 64 * 1024) },
    ...Array.from({ length: 511 }, (_, index) => ({
      path: `assets/${String(index).padStart(3, "0")}.txt`,
      content: "",
    })),
  ];

  const response = await callUploadBundle(
    makeDocuments((uploadedFiles) => {
      uploadedFileCount = uploadedFiles.length;
      packedBytes = packCloudBundle(uploadedFiles).byteLength;
    }),
    { title: "maximum bundle", files }
  );

  assert.equal(response.result?.isError, undefined);
  assert.equal(uploadedFileCount, 512);
  assert.ok(packedBytes <= cloudBundleMaxBytes);
  assert.ok(packedBytes > cloudBundleMaxBytes - 64 * 1024);
});
