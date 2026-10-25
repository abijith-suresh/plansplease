import assert from "node:assert/strict";
import { test } from "node:test";

import {
  signAbandonDocumentProof,
  signCreateDocumentProof,
  verifyAbandonDocumentProof,
  verifyCreateDocumentProof,
} from "../convex/documentProof.ts";
import { signMcpDocumentProof, verifyMcpDocumentProof } from "../convex/mcpProof.ts";

const secret = "test-secret-for-document-mutation-proofs";
const createInput = {
  ownerId: "owner_123",
  title: "My document",
  storageProvider: "uploadthing",
  storageKey: "uploadthing-custom-id:owner_123:uuid-123",
  contentType: "text/html",
  sizeBytes: 42,
};
const abandonInput = { ...createInput, uploadConfirmed: true };
const mcpInput = { action: "delete" as const, ownerId: "user-one", arguments: ["document-one"] };
test("signed proofs reject wrong keys, expiry, future dates, and malformed signatures", async (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const proof = await signCreateDocumentProof(secret, createInput);
  const verify = (candidate = proof, key = secret, now = Date.now()) =>
    verifyCreateDocumentProof(key, createInput, candidate, now);
  assert.equal(await verify(), true);
  assert.equal(await verify(proof, "wrong-secret"), false);
  assert.equal(await verify(proof, secret, proof.expiresAt), true);
  assert.equal(await verify(proof, secret, proof.expiresAt + 1), false);
  assert.equal(await verify(proof, secret, proof.expiresAt - 90_000), true);
  assert.equal(await verify(proof, secret, proof.expiresAt - 90_001), false);
  assert.equal(await verify({ ...proof, expiresAt: NaN }), false);
  assert.equal(await verify({ ...proof, signature: "not-a-signature" }), false);
  assert.equal(await verify({ ...proof, expiresAt: proof.expiresAt + 1 }), false);
});

test("create and abandon proofs bind every stored metadata field", async () => {
  const createProof = await signCreateDocumentProof(secret, createInput);
  const abandonProof = await signAbandonDocumentProof(secret, abandonInput);
  assert.equal(await verifyAbandonDocumentProof(secret, abandonInput, abandonProof), true);
  for (const changed of [
    { ownerId: "owner_other" },
    { title: "Other document" },
    { storageProvider: "filesystem" },
    { storageKey: "another-key" },
    { contentType: "application/vnd.planview.bundle" },
    { sizeBytes: 43 },
  ]) {
    assert.equal(
      await verifyCreateDocumentProof(secret, { ...createInput, ...changed }, createProof),
      false
    );
    assert.equal(
      await verifyAbandonDocumentProof(secret, { ...abandonInput, ...changed }, abandonProof),
      false
    );
  }
  assert.equal(
    await verifyAbandonDocumentProof(
      secret,
      { ...abandonInput, uploadConfirmed: false },
      abandonProof
    ),
    false
  );
  assert.equal(await verifyAbandonDocumentProof(secret, abandonInput, createProof), false);
  assert.equal(await verifyCreateDocumentProof(secret, createInput, abandonProof), false);
});

test("MCP proof binds account, operation, and arguments", async () => {
  const proof = await signMcpDocumentProof(secret, mcpInput);
  assert.equal(await verifyMcpDocumentProof(secret, mcpInput, proof), true);
  for (const changed of [
    { ownerId: "user-two" },
    { action: "get" as const },
    { arguments: ["document-two"] },
  ]) {
    assert.equal(await verifyMcpDocumentProof(secret, { ...mcpInput, ...changed }, proof), false);
  }
});
