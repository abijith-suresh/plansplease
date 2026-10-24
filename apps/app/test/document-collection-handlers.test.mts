import assert from "node:assert/strict";
import { test } from "node:test";
import { ConvexConfigurationError } from "../src/lib/convex-configuration-error.ts";

import {
  createDocumentCollectionHandlers,
  type DocumentCollectionHandlerDependencies,
} from "../src/lib/document-collection-handlers.ts";

type TestClient = object;

function createHandlers(
  overrides: Partial<DocumentCollectionHandlerDependencies<TestClient>> = {}
) {
  const calls = {
    getAuthedClient: 0,
    listDocuments: 0,
    pageOptions: [] as Array<{ cursor: string | null; numItems: number }>,
  };
  const handlers = createDocumentCollectionHandlers<TestClient>({
    getAuthedClient: async () => {
      calls.getAuthedClient += 1;
      return { client: {}, token: "convex-token" };
    },
    listDocuments: async () => {
      calls.listDocuments += 1;
      return [{ _id: "document_123", title: "My document" }];
    },
    listDocumentPage: async (_client, options) => {
      calls.pageOptions.push(options);
      return {
        page: [{ _id: "document_123", title: "My document" }],
        isDone: true,
        continueCursor: "end",
      };
    },
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) =>
      Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 }),
    ...overrides,
  });

  return { calls, handlers };
}

const getRequest = () => new Request("http://localhost/api/documents");

test("lists documents for an authenticated request", async () => {
  const { calls, handlers } = createHandlers();
  const response = await handlers.GET({ request: getRequest() });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ _id: "document_123", title: "My document" }]);
  assert.equal(calls.listDocuments, 1);
});

test("returns an owner-scoped cursor page when pagination is requested", async () => {
  const { calls, handlers } = createHandlers();
  const response = await handlers.GET({
    request: new Request("http://localhost/api/documents?limit=25&cursor=next-page"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    page: [{ _id: "document_123", title: "My document" }],
    isDone: true,
    continueCursor: "end",
  });
  assert.deepEqual(calls.pageOptions, [{ cursor: "next-page", numItems: 25 }]);
  assert.equal(calls.listDocuments, 0);
});

test("defaults a cursor request to 50 documents", async () => {
  const { calls, handlers } = createHandlers();
  const response = await handlers.GET({
    request: new Request("http://localhost/api/documents?cursor=next-page"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.pageOptions, [{ cursor: "next-page", numItems: 50 }]);
});

test("rejects invalid pagination before querying documents", async () => {
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=abc",
    "cursor=",
    "limit=1&limit=2",
  ]) {
    const { calls, handlers } = createHandlers();
    const response = await handlers.GET({
      request: new Request(`http://localhost/api/documents?${query}`),
    });

    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "Invalid pagination parameters" });
    assert.equal(calls.getAuthedClient, 0);
    assert.equal(calls.listDocuments, 0);
    assert.deepEqual(calls.pageOptions, []);
  }
});

test("does not list documents without an authenticated token", async () => {
  const { calls, handlers } = createHandlers({
    getAuthedClient: async () => ({ client: {}, token: null }),
  });
  const response = await handlers.GET({ request: getRequest() });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.listDocuments, 0);
});

test("maps list failures through the configured error responses", async () => {
  const configurationHandlers = createHandlers({
    getAuthedClient: async () => {
      throw new ConvexConfigurationError();
    },
  });
  const configurationResponse = await configurationHandlers.handlers.GET({ request: getRequest() });

  assert.equal(configurationResponse.status, 503);
  assert.deepEqual(await configurationResponse.json(), { error: "backend unavailable" });

  const sameMessageFailureHandlers = createHandlers({
    getAuthedClient: async () => {
      throw new Error("Convex is not configured");
    },
  });
  const sameMessageResponse = await sameMessageFailureHandlers.handlers.GET({
    request: getRequest(),
  });
  assert.equal(sameMessageResponse.status, 500);

  const failureHandlers = createHandlers({
    listDocuments: async () => {
      throw new Error("query failed");
    },
  });
  const failureResponse = await failureHandlers.handlers.GET({ request: getRequest() });

  assert.equal(failureResponse.status, 500);
  assert.deepEqual(await failureResponse.json(), { error: "query failed" });
});
