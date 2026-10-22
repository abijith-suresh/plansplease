import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { isFilesystemKey, isLocalDevelopment } from "../convex/localMode.ts";
import { verifyUploadInput } from "../convex/documents.ts";
import { signCreateDocumentProof } from "../convex/documentProof.ts";
import { localSignInReturnTo } from "../src/lib/local-sign-in.ts";
import {
  createFilesystemStorage,
  signLocalStorage,
  verifyLocalStorage,
} from "../src/lib/document-storage-filesystem.ts";
import {
  documentPreviewResponse,
  localDocumentPreviewResponse,
} from "../src/lib/document-preview.ts";

const objectId = "owner:3a8954ec-ac2f-4d30-8a6e-e0fbe12dc888";
const key = `filesystem:${objectId}`;
const localEnv = {
  PLANVIEW_LOCAL: "true",
  SITE_URL: "http://127.0.0.1:3000",
  CONVEX_CLOUD_URL: "http://127.0.0.1:3210",
};

test("local auth and storage require an explicit flag, development, and both loopback origins", () => {
  assert.equal(isLocalDevelopment(localEnv), true);
  for (const env of [
    { ...localEnv, PLANVIEW_LOCAL: undefined },
    { ...localEnv, NODE_ENV: "production" },
    { ...localEnv, SITE_URL: "https://app.example" },
    { ...localEnv, CONVEX_CLOUD_URL: "https://cloud.convex.cloud" },
    { ...localEnv, SITE_URL: "http://127.0.0.1.evil.example:3000" },
    { ...localEnv, CONVEX_CLOUD_URL: "http://user@127.0.0.1:3210" },
  ])
    assert.equal(isLocalDevelopment(env), false);
});

test("login retains CLI and OAuth return paths and rejects external or control-character redirects", () => {
  const cli = "/cli/authorize?state=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A1000%2Fcallback";
  assert.equal(localSignInReturnTo(`?returnTo=${encodeURIComponent(cli)}`), cli);
  assert.equal(
    localSignInReturnTo("?oauth_query=client_id%3Dlocal%26state%3Dabc"),
    "/mcp/consent?client_id=local&state=abc"
  );
  for (const path of [
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "https://evil.example",
    "/\n/evil.example",
    "/\u0000/evil.example",
  ]) {
    assert.equal(localSignInReturnTo(`?returnTo=${encodeURIComponent(path)}`), "/documents");
  }
});

test("filesystem uploads persist across adapter restarts, refuse replacement, and delete idempotently", async () => {
  const root = await mkdtemp(join(tmpdir(), "plansplease-storage-"));
  try {
    const storage = createFilesystemStorage(root, () => "http://127.0.0.1:3000/api/local-storage");
    const input = {
      file: new File(["<h1>Persistent</h1>"], "page.html"),
      objectId,
      deadlineAt: Date.now() + 60_000,
    };
    const stored = await storage.upload(input);
    assert.deepEqual(stored, { storageProvider: "filesystem", storageKey: key });
    await assert.rejects(
      storage.upload({ ...input, file: new File(["replace"], "other.html") }),
      /EEXIST/
    );
    const restarted = createFilesystemStorage(root, () => "unused");
    assert.equal(new TextDecoder().decode(await restarted.read(key)), "<h1>Persistent</h1>");
    await assert.rejects(
      storage.upload({
        ...input,
        objectId: "owner:3a8954ec-ac2f-4d30-8a6e-e0fbe12dc889",
        deadlineAt: Date.now() - 1,
      }),
      /expired/
    );
    assert.equal((await readdir(root)).length, 1);
    await restarted.delete(key);
    await restarted.delete(key);
    await assert.rejects(restarted.read(key), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem storage rejects traversal and never follows object symlinks", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "plansplease-safe-storage-"));
  try {
    const storage = createFilesystemStorage(root, () => "unused");
    for (const invalid of ["../secret", "filesystem:owner:../../secret", "filesystem:owner:uuid"]) {
      assert.equal(isFilesystemKey(invalid, "owner"), false);
      await assert.rejects(storage.read(invalid), /Invalid local storage locator/);
    }
    assert.equal(isFilesystemKey(key, "someone-else"), false);
    const outside = join(root, "outside");
    await writeFile(outside, "private");
    await symlink(outside, join(root, `${createHash("sha256").update(key).digest("hex")}.blob`));
    await assert.rejects(storage.read(key), /Unsafe local storage object|ELOOP/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("byte capabilities expire and cannot be changed from read to delete or to another key", () => {
  const secret = "local-test-secret-longer-than-thirty-two-bytes";
  const expires = Date.now() + 60_000;
  const signature = signLocalStorage(secret, "read", key, expires);
  assert.equal(verifyLocalStorage(secret, "read", key, expires, signature), true);
  assert.equal(verifyLocalStorage(secret, "delete", key, expires, signature), false);
  assert.equal(
    verifyLocalStorage(secret, "read", key.replace("owner", "other"), expires, signature),
    false
  );
  assert.equal(verifyLocalStorage(secret, "read", key, Date.now() - 1, signature), false);
});

test("Convex accepts signed local locators only for their owner in local mode", async () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, localEnv, {
      NODE_ENV: "development",
      DOCUMENT_MUTATION_SECRET: "test-proof-secret-longer-than-thirty-two-bytes",
    });
    const input = {
      ownerId: "owner",
      title: "Local",
      storageProvider: "filesystem",
      storageKey: key,
      contentType: "text/html",
      sizeBytes: 1,
    };
    const proof = await signCreateDocumentProof(process.env["DOCUMENT_MUTATION_SECRET"]!, input);
    await verifyUploadInput("owner", { ...input, proof });
    await assert.rejects(
      verifyUploadInput("other", { ...input, proof }),
      /Invalid document metadata/
    );
    process.env["PLANVIEW_LOCAL"] = "false";
    await assert.rejects(
      verifyUploadInput("owner", { ...input, proof }),
      /Invalid document metadata/
    );
  } finally {
    process.env = original;
  }
});

test("hosted preview keeps HTTPS enforcement; local preview accepts only its own signed-byte route", () => {
  const original = { ...process.env };
  try {
    Object.assign(process.env, localEnv, { NODE_ENV: "development" });
    assert.throws(
      () => documentPreviewResponse("http://127.0.0.1:3000/api/local-storage"),
      /invalid preview URL/
    );
    const response = localDocumentPreviewResponse("http://127.0.0.1:3000/api/local-storage?key=x");
    assert.match(
      response.headers.get("Content-Security-Policy")!,
      /connect-src https: http:\/\/127.0.0.1:3000/
    );
    assert.throws(
      () => localDocumentPreviewResponse("http://127.0.0.1:3000/api/auth/get-session"),
      /Invalid local preview/
    );
    assert.throws(
      () => localDocumentPreviewResponse("http://localhost:9999/api/local-storage"),
      /Invalid local preview/
    );
    process.env["NODE_ENV"] = "production";
    assert.throws(
      () => localDocumentPreviewResponse("http://127.0.0.1:3000/api/local-storage"),
      /Invalid local preview/
    );
  } finally {
    process.env = original;
  }
});
