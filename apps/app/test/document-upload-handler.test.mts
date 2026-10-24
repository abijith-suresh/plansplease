import { cloudBundleContentType, packCloudBundle } from "../src/lib/cloud-bundle.ts";
import { ConvexError } from "convex/values";
import { ConvexConfigurationError } from "../src/lib/convex-configuration-error.ts";
import { cloudDocumentMaxBytes } from "@planview/core/cloud-policy";
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDocumentUploadHandler,
  type DocumentUploadHandlerDependencies,
  type DocumentUploadMetadata,
} from "../src/lib/document-upload-handler.ts";

type TestClient = object;

const uploadRequestSizeLimit = cloudDocumentMaxBytes + 64 * 1024;

function createHandler(overrides: Partial<DocumentUploadHandlerDependencies<TestClient>> = {}) {
  const calls = {
    getCurrentUser: 0,
    uploads: [] as { objectId: string; fileName: string }[],
    metadata: [] as DocumentUploadMetadata[],
    metadataOwners: [] as string[],
    abandonedKeys: [] as string[],
  };
  const handler = createDocumentUploadHandler<TestClient>({
    getAuthedClient: async () => ({ client: {}, token: "convex-token" }),
    getCurrentUser: async () => {
      calls.getCurrentUser += 1;
      return { subject: "owner_123" };
    },
    isStorageConfigured: () => true,
    getUploadLocator: (objectId) => ({
      storageProvider: "uploadthing",
      storageKey: `uploadthing-custom-id:${objectId}`,
    }),
    uploadFile: async ({ file, objectId }) => {
      calls.uploads.push({ objectId, fileName: file.name });
      return { storageProvider: "uploadthing", storageKey: `uploadthing-custom-id:${objectId}` };
    },
    reserveMetadata: async () => ({ id: null, uploadDeadlineAt: Date.now() + 60_000 }),
    abandonMetadata: async (_client, input) => {
      calls.abandonedKeys.push(input.storageKey);
      return null;
    },
    createMetadata: async (_client, input, ownerId) => {
      calls.metadata.push(input);
      calls.metadataOwners.push(ownerId);
      return "document_123";
    },
    createUploadId: () => "uuid-123",
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) =>
      Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 }),
    ...overrides,
  });

  return { calls, handler };
}

function createUploadRequest(
  options: { title?: string; files?: File[]; contentLength?: string | null } = {}
) {
  const form = new FormData();
  form.set("title", options.title ?? "My document");
  for (const file of options.files ?? [
    new File(["<h1>hello</h1>"], "hello.html", { type: "text/html" }),
  ]) {
    form.append("file", file);
  }

  const init: RequestInit = {
    method: "POST",
    body: form,
    ...(options.contentLength === null
      ? {}
      : { headers: { "content-length": options.contentLength ?? "512" } }),
  };
  return new Request("http://localhost/api/documents/upload", init);
}

test("rejects invalid or oversized Content-Length before authentication", async (t) => {
  for (const [name, contentLength, expectedStatus] of [
    ["not numeric", "not-a-number", 400],
    ["over the request limit", String(uploadRequestSizeLimit + 1), 413],
  ] as const) {
    await t.test(name, async () => {
      const { calls, handler } = createHandler({
        getAuthedClient: async () => {
          throw new Error("authentication must not run");
        },
      });
      const response = await handler({ request: createUploadRequest({ contentLength }) });

      assert.equal(response.status, expectedStatus);
      assert.equal(calls.getCurrentUser, 0);
      assert.equal(calls.uploads.length, 0);
      assert.equal(calls.metadata.length, 0);
    });
  }
});

test("accepts browser uploads without Content-Length", async () => {
  const { calls, handler } = createHandler();
  const response = await handler({ request: createUploadRequest({ contentLength: null }) });

  assert.equal(response.status, 201);
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.metadata.length, 1);
});

test("rejects a streamed body larger than the request cap", async () => {
  const { calls, handler } = createHandler();
  const response = await handler({
    request: new Request("http://localhost/api/documents/upload", {
      method: "POST",
      body: new Blob([new Uint8Array(uploadRequestSizeLimit + 1)]),
    }),
  });

  assert.equal(response.status, 413);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.metadata.length, 0);
});

test("rejects invalid titles, multiple files, non-HTML files, and files larger than 8 MiB", async (t) => {
  const invalidCases: Array<{ name: string; title?: string; files?: File[] }> = [
    { name: "blank title", title: "   " },
    { name: "title over 200 characters", title: "t".repeat(201) },
    {
      name: "multiple files",
      files: [
        new File(["first"], "first.html", { type: "text/html" }),
        new File(["second"], "second.html", { type: "text/html" }),
      ],
    },
    {
      name: "non-HTML extension",
      files: [new File(["<h1>hello</h1>"], "hello.txt", { type: "text/html" })],
    },
    {
      name: "non-HTML MIME type",
      files: [new File(["<h1>hello</h1>"], "hello.html", { type: "text/plain" })],
    },
    {
      name: "file larger than 8 MiB",
      files: [
        new File([new Uint8Array(cloudDocumentMaxBytes + 1)], "large.html", { type: "text/html" }),
      ],
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const { calls, handler } = createHandler();
      const response = await handler({
        request: createUploadRequest({
          title: invalidCase.title ?? "A valid title",
          ...(invalidCase.files === undefined ? {} : { files: invalidCase.files }),
        }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error:
          "Upload one HTML file or artifact bundle up to 8 MiB with a title of 1 to 200 characters",
      });
      assert.equal(calls.uploads.length, 0);
      assert.equal(calls.metadata.length, 0);
    });
  }
});

test("an unauthenticated caller cannot upload a file or create metadata", async () => {
  const { calls, handler } = createHandler({
    getAuthedClient: async () => ({ client: {}, token: null }),
  });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.getCurrentUser, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.metadata.length, 0);
});

test("stores one HTML file and binds its storage key to the authenticated owner", async () => {
  const { calls, handler } = createHandler();
  const response = await handler({
    request: createUploadRequest({ title: "  My document  " }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "document_123" });
  assert.deepEqual(calls.uploads, [{ objectId: "owner_123:uuid-123", fileName: "hello.html" }]);
  assert.deepEqual(calls.metadata, [
    {
      title: "My document",
      storageProvider: "uploadthing",
      storageKey: "uploadthing-custom-id:owner_123:uuid-123",
      contentType: "text/html",
      sizeBytes: 14,
    },
  ]);
  assert.deepEqual(calls.metadataOwners, ["owner_123"]);
  assert.deepEqual(calls.abandonedKeys, []);
});

test("maps explicit Convex configuration failures to the existing 503 response", async () => {
  const { calls, handler } = createHandler({
    getAuthedClient: async () => {
      throw new ConvexConfigurationError();
    },
  });
  const response = await handler({ request: createUploadRequest() });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "backend unavailable" });
  assert.equal(calls.uploads.length, 0);
});

test("does not create metadata when storing the uploaded file fails", async () => {
  let uploadAttempts = 0;
  const { calls, handler } = createHandler({
    uploadFile: async () => {
      uploadAttempts += 1;
      throw new Error("storage upload failed");
    },
  });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "storage upload failed" });
  assert.equal(uploadAttempts, 1);
  assert.equal(calls.metadata.length, 0);
  assert.deepEqual(calls.abandonedKeys, ["uploadthing-custom-id:owner_123:uuid-123"]);
});

test("fences the reserved upload for durable cleanup if metadata creation fails", async () => {
  const { calls, handler } = createHandler({
    createMetadata: async () => {
      throw new Error("metadata creation failed");
    },
  });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "metadata creation failed" });
  assert.deepEqual(calls.uploads, [{ objectId: "owner_123:uuid-123", fileName: "hello.html" }]);
  assert.deepEqual(calls.abandonedKeys, ["uploadthing-custom-id:owner_123:uuid-123"]);
});

test("reports an unavailable cancellation and keeps the metadata error response", async () => {
  const metadataCause = new Error("metadata creation failed");
  const cleanupCause = new Error("storage deletion failed");
  const reports: Array<{
    objectKey: string;
    metadataCause: unknown;
    cleanupCause: unknown;
  }> = [];
  const { calls, handler } = createHandler({
    createMetadata: async () => {
      throw metadataCause;
    },
    abandonMetadata: async (_client, input) => {
      calls.abandonedKeys.push(input.storageKey);
      throw cleanupCause;
    },
    reportCompensationFailure: async (failure) => {
      reports.push(failure);
      throw new Error("reporting failed");
    },
  });

  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "metadata creation failed" });
  assert.deepEqual(calls.abandonedKeys, ["uploadthing-custom-id:owner_123:uuid-123"]);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    objectKey: "uploadthing-custom-id:owner_123:uuid-123",
    metadataCause,
    cleanupCause,
  });
});

test("does not expose file storage when it is not configured", async () => {
  const { calls, handler } = createHandler({ isStorageConfigured: () => false });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "File storage is not configured yet.",
    code: "STORAGE_NOT_CONFIGURED",
  });
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.metadata.length, 0);
});

test("quota rejection happens before provider uploads and returns actionable structured data", async () => {
  const failure = {
    code: "STORAGE_QUOTA_EXCEEDED",
    message: "Delete documents before uploading more.",
    limitBytes: 500_000_000,
    usedBytes: 499_999_999,
    requestedBytes: 14,
  };
  const { calls, handler } = createHandler({
    reserveMetadata: async () => {
      throw new ConvexError(failure);
    },
  });
  const response = await handler({ request: createUploadRequest() });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { ...failure, error: failure.message });
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.metadata.length, 0);
  assert.equal(calls.abandonedKeys.length, 0);
});

test("an ambiguous committed response is recovered without deleting storage", async () => {
  let confirmed: boolean | undefined;
  const { handler } = createHandler({
    createMetadata: async () => {
      throw new Error("response lost after commit");
    },
    abandonMetadata: async (_client, _input, _ownerId, _request, uploadConfirmed) => {
      confirmed = uploadConfirmed;
      return "committed-document";
    },
  });
  const response = await handler({ request: createUploadRequest() });
  assert.equal(confirmed, true);
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "committed-document" });
});

test("a provider timeout is marked uncertain rather than safe for cleanup", async () => {
  let confirmed: boolean | undefined;
  const { handler } = createHandler({
    uploadFile: async () => {
      throw new Error("upload timeout");
    },
    abandonMetadata: async (_client, _input, _ownerId, _request, uploadConfirmed) => {
      confirmed = uploadConfirmed;
      return null;
    },
  });
  const response = await handler({ request: createUploadRequest() });
  assert.equal(response.status, 500);
  assert.equal(confirmed, false);
});

test("reserves the adapter locator before upload and forwards its absolute deadline", async () => {
  const order: string[] = [];
  const deadlineAt = Date.now() + 60_000;
  const locator = { storageProvider: "uploadthing" as const, storageKey: "provider-owned-locator" };
  const { handler } = createHandler({
    getUploadLocator: (objectId) => {
      assert.equal(objectId, "owner_123:uuid-123");
      return locator;
    },
    reserveMetadata: async (_client, input) => {
      order.push("reserve");
      assert.equal(input.storageKey, locator.storageKey);
      return { id: null, uploadDeadlineAt: deadlineAt };
    },
    uploadFile: async (input) => {
      order.push("upload");
      assert.equal(input.deadlineAt, deadlineAt);
      assert.equal(input.objectId, "owner_123:uuid-123");
      return locator;
    },
    createMetadata: async (_client, input) => {
      order.push("commit");
      assert.equal(input.storageKey, locator.storageKey);
      return "document_123";
    },
  });
  assert.equal((await handler({ request: createUploadRequest() })).status, 201);
  assert.deepEqual(order, ["reserve", "upload", "commit"]);
});

test("a mismatched provider locator cannot authorize reserved-object cleanup or commit", async () => {
  let confirmed: boolean | undefined;
  const { calls, handler } = createHandler({
    uploadFile: async () => ({ storageProvider: "uploadthing", storageKey: "different-object" }),
    abandonMetadata: async (_client, _input, _ownerId, _request, uploadConfirmed) => {
      confirmed = uploadConfirmed;
      return null;
    },
  });
  const response = await handler({ request: createUploadRequest() });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /does not match its upload reservation/);
  assert.equal(confirmed, false);
  assert.equal(calls.metadata.length, 0);
});

test("an existing committed reservation skips provider bytes and metadata writes", async () => {
  const { calls, handler } = createHandler({
    reserveMetadata: async () => ({ id: "existing-document", uploadDeadlineAt: 0 }),
  });
  const response = await handler({ request: createUploadRequest() });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "existing-document" });
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.metadata.length, 0);
  assert.equal(calls.abandonedKeys.length, 0);
});

test("bundle multipart uploads validate before quota admission and preserve exact encoded charge", async () => {
  const bytes = packCloudBundle([
    { path: "index.html", content: "<h1>Artifact</h1>" },
    { path: "style.css", content: "h1{color:red}" },
  ]);
  const { calls, handler } = createHandler();
  const response = await handler({
    request: createUploadRequest({
      files: [
        new File([new Uint8Array(bytes)], "artifact.planview", { type: cloudBundleContentType }),
      ],
    }),
  });
  assert.equal(response.status, 201);
  assert.equal(calls.metadata[0]?.contentType, cloudBundleContentType);
  assert.equal(calls.metadata[0]?.sizeBytes, bytes.byteLength);
  const invalid = createHandler({
    reserveMetadata: async () => assert.fail("invalid bundle must not reserve"),
  });
  assert.equal(
    (
      await invalid.handler({
        request: createUploadRequest({
          files: [new File(["invalid"], "artifact.planview", { type: cloudBundleContentType })],
        }),
      })
    ).status,
    400
  );
  assert.equal(invalid.calls.uploads.length, 0);
});
