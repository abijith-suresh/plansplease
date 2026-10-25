import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";

import {
  signAbandonDocumentProof,
  signCreateDocumentProof,
  verifyAbandonDocumentProof,
  verifyCreateDocumentProof,
} from "../convex/documentProof.ts";
import { signMcpDocumentProof, verifyMcpDocumentProof } from "../convex/mcpProof.ts";
import type { SignedProof } from "../convex/signedProof.ts";

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
const metadataFields = [
  createInput.ownerId,
  createInput.title,
  createInput.storageProvider,
  createInput.storageKey,
  createInput.contentType,
  createInput.sizeBytes,
];

const proofTypes = [
  {
    name: "create",
    sign: () => signCreateDocumentProof(secret, createInput),
    verify: (proof: SignedProof, key = secret, now?: number) =>
      verifyCreateDocumentProof(key, createInput, proof, now),
    message: (expiresAt: number) => JSON.stringify(["create", ...metadataFields, expiresAt]),
  },
  {
    name: "abandon",
    sign: () => signAbandonDocumentProof(secret, abandonInput),
    verify: (proof: SignedProof, key = secret, now?: number) =>
      verifyAbandonDocumentProof(key, abandonInput, proof, now),
    message: (expiresAt: number) =>
      JSON.stringify(["abandon-upload", ...metadataFields, true, expiresAt]),
  },
  {
    name: "MCP",
    sign: () => signMcpDocumentProof(secret, mcpInput),
    verify: (proof: SignedProof, key = secret, now?: number) =>
      verifyMcpDocumentProof(key, mcpInput, proof, now),
    message: (expiresAt: number) =>
      JSON.stringify([
        "planview-mcp-documents-v1",
        "delete",
        "user-one",
        ["document-one"],
        expiresAt,
      ]),
  },
];

for (const proofType of proofTypes) {
  test(`${proofType.name} proof preserves its signed message and rejects invalid proofs`, async (t) => {
    const now = 1_000_000;
    t.mock.method(Date, "now", () => now);
    const proof = await proofType.sign();
    assert.equal(proof.expiresAt, now + 60_000);
    assert.equal(
      proof.signature,
      createHmac("sha256", secret).update(proofType.message(proof.expiresAt)).digest("hex")
    );
    assert.equal(await proofType.verify(proof), true);
    assert.equal(await proofType.verify(proof, "wrong-secret"), false);
    assert.equal(await proofType.verify(proof, secret, proof.expiresAt), true);
    assert.equal(await proofType.verify(proof, secret, proof.expiresAt + 1), false);
    assert.equal(await proofType.verify(proof, secret, proof.expiresAt - 90_000), true);
    assert.equal(await proofType.verify(proof, secret, proof.expiresAt - 90_001), false);
    for (const expiresAt of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(await proofType.verify({ ...proof, expiresAt }), false);
    }
    for (const signature of [
      "",
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      proof.signature.toUpperCase(),
    ]) {
      assert.equal(await proofType.verify({ ...proof, signature }), false);
    }
    assert.equal(await proofType.verify({ ...proof, expiresAt: proof.expiresAt + 1 }), false);
  });
}

test("create and abandon proofs bind every stored metadata field", async () => {
  const createProof = await signCreateDocumentProof(secret, createInput);
  const abandonProof = await signAbandonDocumentProof(secret, abandonInput);
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
  for (const changed of [
    { ownerId: "user-two" },
    { action: "get" as const },
    { arguments: ["document-two"] },
  ]) {
    assert.equal(await verifyMcpDocumentProof(secret, { ...mcpInput, ...changed }, proof), false);
  }
});
