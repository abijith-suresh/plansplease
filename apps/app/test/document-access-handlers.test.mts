import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDocumentDeleteHandler,
  createDocumentPreviewHandler,
  type DocumentAccessHandlerDependencies,
  type DocumentAccessRecord,
  type DocumentRouteEvent,
} from "../src/lib/document-access-handlers.ts";

type TestClient = { readonly name: "client" };

const documentId = "document_123";
const storageKey = "uploadthing-custom-id:owner_123:uuid-123";
const storedDocument: DocumentAccessRecord = {
  contentType: "text/html",
  storageProvider: "uploadthing",
  storageKey,
};

type HandlerCalls = {
  events: string[];
  fetches: Array<{ input: string; authorization: string | null }>;
};

function createHandlers(
  overrides:
    | Partial<DocumentAccessHandlerDependencies<TestClient>>
    | ((calls: HandlerCalls) => Partial<DocumentAccessHandlerDependencies<TestClient>>) = {}
) {
  const calls = {
    events: [] as string[],
    fetches: [] as Array<{ input: string; authorization: string | null }>,
  };
  const resolvedOverrides = typeof overrides === "function" ? overrides(calls) : overrides;
  const dependencies: DocumentAccessHandlerDependencies<TestClient> = {
    getAuthedClient: async () => {
      calls.events.push("authenticate");
      return { client: { name: "client" }, token: "convex-token" };
    },
    getDocument: async (_client, id) => {
      calls.events.push("get-document");
      assert.equal(id, documentId);
      return storedDocument;
    },
    getDocumentStorage: () => {
      calls.events.push("get-storage");
      return {
        provider: "uploadthing",
        getUploadLocator: () => ({ storageProvider: "uploadthing", storageKey }),
        upload: async () => ({ storageProvider: "uploadthing", storageKey }),
        getReadUrl: async () => {
          calls.events.push("get-read-url");
          return "https://storage.example/document.html";
        },
        delete: async (key) => {
          calls.events.push("delete-object");
          assert.equal(key, storageKey);
        },
      };
    },
    fetch: async (input, init) => {
      calls.events.push("fetch");
      calls.fetches.push({
        input,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("<h1>Preview</h1>", { status: 200 });
    },
    convexSiteUrl: "https://convex.example",
    proxyResponse: async (response) => {
      calls.events.push("proxy-response");
      return response;
    },
    requestDeletion: async () => {
      calls.events.push("request-deletion");
      return "accepted";
    },
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) => {
      calls.events.push("error-response");
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown" },
        { status: 500 }
      );
    },
    ...resolvedOverrides,
  };

  return {
    calls,
    preview: createDocumentPreviewHandler(dependencies),
    remove: createDocumentDeleteHandler(dependencies),
  };
}

const event = (): DocumentRouteEvent => ({
  request: new Request(`http://localhost/api/documents/${documentId}`),
  params: { id: documentId },
});

test("does not look up storage when the authenticated user cannot access a document", async () => {
  const { calls, preview } = createHandlers((calls) => ({
    getDocument: async () => {
      calls.events.push("get-document");
      return null;
    },
  }));

  const response = await preview(event());

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.deepEqual(calls.events, ["authenticate", "get-document"]);
  assert.deepEqual(calls.fetches, []);
});

test("requires a session before looking up or reading a document", async () => {
  const { calls, preview, remove } = createHandlers({
    getAuthedClient: async () => {
      calls.events.push("authenticate");
      return { client: { name: "client" }, token: null };
    },
  });

  const previewResponse = await preview(event());
  const deleteResponse = await remove(event());

  assert.equal(previewResponse.status, 401);
  assert.equal(await previewResponse.text(), "Authentication required");
  assert.equal(deleteResponse.status, 401);
  assert.deepEqual(await deleteResponse.json(), { error: "Authentication required" });
  assert.deepEqual(calls.events, ["authenticate", "authenticate"]);
});

test("authorizes before returning a direct browser preview without server byte fetches", async () => {
  const { calls, preview } = createHandlers();
  const response = await preview(event());
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes("https://storage.example/document.html"));
  assert.deepEqual(calls.events, ["authenticate", "get-document", "get-storage", "get-read-url"]);
  assert.deepEqual(calls.fetches, []);
});

test("proxies legacy Convex-backed documents with the authenticated token", async () => {
  const { calls, preview } = createHandlers({
    getDocument: async () => ({ contentType: "text/html" }),
  });

  const response = await preview(event());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.fetches, [
    {
      input: `https://convex.example/documents/content?id=${documentId}`,
      authorization: "Bearer convex-token",
    },
  ]);
  assert.ok(calls.events.includes("proxy-response"));
});

test("accepts deletion without contacting storage in the request", async () => {
  const { calls, remove } = createHandlers();

  const response = await remove(event());

  assert.equal(response.status, 202);
  assert.deepEqual(calls.events, ["authenticate", "request-deletion"]);
});

test("returns not found when deletion cannot access the document", async () => {
  const { calls, remove } = createHandlers((calls) => ({
    requestDeletion: async () => {
      calls.events.push("request-deletion");
      return "not_found";
    },
  }));

  const response = await remove(event());

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "Document not found" });
  assert.deepEqual(calls.events, ["authenticate", "request-deletion"]);
});

test("does not acknowledge deletion if Convex cannot record it", async () => {
  const { calls, remove } = createHandlers((calls) => ({
    requestDeletion: async () => {
      calls.events.push("request-deletion");
      throw new Error("Convex unavailable");
    },
  }));

  const response = await remove(event());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Convex unavailable" });
  assert.deepEqual(calls.events, ["authenticate", "request-deletion", "error-response"]);
});
