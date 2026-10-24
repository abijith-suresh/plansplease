import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createCliRevocationHandler,
  createCliSessionHandler,
} from "../src/lib/cli-session-handler.ts";
import { hashCliCredential } from "../src/lib/cli-credential.ts";
import { ConvexConfigurationError } from "../src/lib/convex-configuration-error.ts";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
};

function createHandler(overrides: Record<string, unknown> = {}) {
  const calls = { getCurrentUser: 0, createCredential: 0, issueCredential: 0 };
  const handler = createCliSessionHandler({
    getAuthedClient: async () => ({ client: {}, token: "convex-token" }),
    getCurrentUser: async () => {
      calls.getCurrentUser += 1;
      return { subject: "owner" };
    },
    createCredential: () => {
      calls.createCredential += 1;
      return { secret: "upload-only-secret", tokenHash: "hash-of-upload-only-secret" };
    },
    issueCredential: async (_client, tokenHash) => {
      calls.issueCredential += 1;
      assert.equal(tokenHash, "hash-of-upload-only-secret");
    },
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) =>
      Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 }),
    ...overrides,
  });

  return { calls, handler };
}

const request = () =>
  new Request("http://localhost/api/cli/session", {
    method: "POST",
    headers: { Origin: "http://localhost" },
  });

test("requires an authenticated Convex token and sends no token when absent", async () => {
  const { calls, handler } = createHandler({
    getAuthedClient: async () => ({ client: {}, token: null }),
  });

  const response = await handler({ request: request() });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.getCurrentUser, 0);
  assert.equal(calls.createCredential, 0);
  assert.equal(calls.issueCredential, 0);
  assert.equal(response.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(response.headers.get("pragma"), privateHeaders.Pragma);
});

test("issues an upload-only credential with private no-store headers", async () => {
  const { calls, handler } = createHandler();

  const response = await handler({ request: request() });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: "upload-only-secret" });
  assert.equal(calls.issueCredential, 1);
  assert.equal(response.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(response.headers.get("pragma"), privateHeaders.Pragma);
});

test("does not issue a CLI credential when the current user is missing", async () => {
  const { calls, handler } = createHandler({ getCurrentUser: async () => null });

  const response = await handler({ request: request() });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.createCredential, 0);
  assert.equal(calls.issueCredential, 0);
  assert.equal(response.headers.get("cache-control"), privateHeaders["Cache-Control"]);
});

test("applies private no-store headers to configuration and general error responses", async () => {
  const configurationHandler = createHandler({
    getAuthedClient: async () => {
      throw new ConvexConfigurationError();
    },
  }).handler;
  const configurationResponse = await configurationHandler({
    request: request(),
  });

  assert.equal(configurationResponse.status, 503);
  assert.equal(configurationResponse.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(configurationResponse.headers.get("pragma"), privateHeaders.Pragma);

  const errorHandler = createHandler({
    getAuthedClient: async () => {
      throw new Error("upstream failed");
    },
  }).handler;
  const errorResponse = await errorHandler({
    request: request(),
  });

  assert.equal(errorResponse.status, 500);
  assert.deepEqual(await errorResponse.json(), { error: "upstream failed" });
  assert.equal(errorResponse.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(errorResponse.headers.get("pragma"), privateHeaders.Pragma);
});

test("rejects a cross-origin credential request before checking the session", async () => {
  const { calls, handler } = createHandler({
    getAuthedClient: async () => {
      throw new Error("session should not be checked");
    },
  });
  const response = await handler({
    request: new Request("http://localhost/api/cli/session", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Invalid request origin" });
  assert.equal(calls.issueCredential, 0);
});

test("revokes only the presented CLI credential", async () => {
  const revoked: string[] = [];
  const handler = createCliRevocationHandler({
    getClient: () => ({}),
    revokeCredential: async (_client, tokenHash) => {
      revoked.push(tokenHash);
    },
    errorResponse: () => Response.json({ error: "backend unavailable" }, { status: 500 }),
  });
  const missing = await handler({
    request: new Request("http://localhost/api/cli/session", { method: "DELETE" }),
  });
  assert.equal(missing.status, 401);
  assert.deepEqual(revoked, []);

  const token = "planview_cli_upload-only-token";
  const response = await handler({
    request: new Request("http://localhost/api/cli/session", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }),
  });
  assert.equal(response.status, 204);
  assert.deepEqual(revoked, [hashCliCredential(token)]);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
