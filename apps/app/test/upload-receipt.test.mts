import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createDocumentUploadHandler } from "../src/lib/document-upload-handler.ts";
import { createUploadReceiptHandler } from "../src/lib/upload-receipt-handler.ts";
import { fingerprintUpload } from "../src/lib/upload-operation.ts";
import {
  signAbandonDocumentProof,
  verifyCreateDocumentProof,
  verifyAbandonDocumentProof,
} from "../convex/documentProof.ts";
import {
  reserveUploadForOwner,
  createForOwner,
  abandonUploadForOwner,
  claimUploadCleanup,
  finishUploadCleanup,
  requestDeletionForOwner,
  finishDeletion,
  uploadReceipt,
  uploadReceiptWithCliCredential,
} from "../convex/documents.ts";
import type { MutationCtx } from "../convex/_generated/server.js";
import type { Id } from "../convex/_generated/dataModel.js";

import { fixture, secret, origin, operationKey, exactBytes } from "./fixtures/upload-protocol.mts";

const handlerOf = <Args,>(fn: unknown) =>
  (fn as { _handler(ctx: MutationCtx, args: Args): Promise<unknown> })._handler;

function request(
  options: {
    bytes?: Uint8Array;
    title?: string;
    key?: string | null;
    origin?: string;
    filename?: string;
    type?: string;
  } = {}
) {
  const form = new FormData();
  form.set("title", options.title ?? "Exact title");
  form.set(
    "file",
    new File([new Uint8Array(options.bytes ?? exactBytes)], options.filename ?? "source.html", {
      type: options.type ?? "text/html",
    })
  );
  return new Request(`${options.origin ?? origin}/api/documents/upload`, {
    method: "POST",
    body: form,
    headers: options.key === null ? {} : { "Idempotency-Key": options.key ?? operationKey },
  });
}
function lookupRequest(key = operationKey) {
  return new Request(`${origin}/api/documents/upload`, { headers: { "Idempotency-Key": key } });
}

// These exercise real handlers, signing, mutation functions and filesystem bytes.
// The database fixture models transaction rollback/retry, not a running Convex service.
test("exact immutable bytes, lost final HTTP response, renamed file and replay resolve one durable document", async (t) => {
  const f = await fixture(t);
  const first = await f.upload({ request: request() });
  assert.equal(first.status, 201);
  const body = await first.json();
  assert.equal(body.receipt.contentSha256, createHash("sha256").update(exactBytes).digest("hex"));
  const row = f.database.rows("documents")[0]!;
  assert.deepEqual(await f.storage.read(String(row["storageKey"])), exactBytes);
  // Discard the first result as if the final HTTP response never reached the client.
  const replay = await f.upload({
    request: request({ filename: "renamed.html", title: " Exact title " }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).id, body.id);
  assert.equal(f.state.uploads, 1);
  assert.equal(f.database.rows("documents").length, 1);
  assert.equal(f.database.rows("uploadReservations").length, 0);
  assert.equal(f.database.rows("accountStorageUsage")[0]!["usedBytes"], exactBytes.length);
  const lookup = await f.lookup({ request: lookupRequest() });
  assert.equal(lookup.status, 200);
  assert.equal((await lookup.json()).receipt.accountId, "owner-a");
  assert.equal(lookup.headers.get("cache-control"), "private, no-store");
});

test("key conflicts on same-length content, title, or content type; account and trusted origin are separate", async (t) => {
  const f = await fixture(t);
  const id = (await (await f.upload({ request: request() })).json()).id;
  for (const options of [
    { bytes: new Uint8Array(exactBytes).fill(0x61) },
    { title: "Other title" },
  ]) {
    const response = await f.upload({ request: request(options) });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "UPLOAD_OPERATION_CONFLICT");
  }
  assert.equal(f.state.uploads, 1);
  f.state.owner = "owner-b";
  assert.equal((await f.lookup({ request: lookupRequest() })).status, 404);
  const other = await (await f.upload({ request: request() })).json();
  assert.notEqual(other.id, id);
  assert.equal(other.receipt.accountId, "owner-b");
  f.state.owner = "owner-a";
  f.state.origin = "http://127.0.0.1:3001";
  assert.equal(
    (await f.upload({ request: request() })).status,
    400,
    "request cannot select the server origin"
  );
  const another = await (await f.upload({ request: request({ origin: f.state.origin }) })).json();
  assert.notEqual(another.id, id);
  assert.equal(another.receipt.origin, f.state.origin);
  assert.equal(f.database.rows("uploadReceipts").length, 3);
  const a = fingerprintUpload({
    key: operationKey,
    origin,
    title: "t",
    contentType: "text/html",
    bytes: exactBytes,
  });
  const b = fingerprintUpload({
    key: operationKey,
    origin,
    title: "t",
    contentType: "application/vnd.planview.bundle",
    bytes: exactBytes,
  });
  assert.notEqual(a.fingerprint, b.fingerprint);
});

test("concurrent requests get one upload lease and pending receipt, then the same committed document", async (t) => {
  const f = await fixture(t);
  const hold = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  f.state.beforeUpload = async () => {
    started.resolve();
    await hold.promise;
  };
  const first = f.upload({ request: request() });
  await Promise.race([
    started.promise,
    first.then(() => assert.fail("first request ended before provider upload")),
  ]);
  const competing = await Promise.all(
    Array.from({ length: 8 }, () => f.upload({ request: request() }))
  );
  assert.ok(competing.every((response) => response.status === 202));
  assert.equal(f.state.uploads, 1);
  assert.equal(f.database.rows("uploadReceipts").length, 1);
  assert.equal(f.database.rows("uploadReservations").length, 1);
  hold.resolve();
  const id = (await (await first).json()).id;
  const replay = await f.upload({ request: request() });
  assert.equal((await replay.json()).id, id);
});

test("lost reservation response keeps unknown state, never replays provider bytes, and cleanup fences eventual failure", async (t) => {
  const f = await fixture(t);
  f.state.reserveLost = true;
  const response = await f.upload({ request: request() });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).outcome, "unknown");
  assert.equal(f.state.uploads, 0);
  f.state.reserveLost = false;
  assert.equal((await f.upload({ request: request() })).status, 202);
  const row = f.database.rows("uploadReservations")[0]!;
  await f.database.transaction((ctx) =>
    ctx.db.patch(row._id as Id<"uploadReservations">, { nextAttemptAt: 0 })
  );
  const claim = await f.database.transaction((ctx) =>
    handlerOf<{ reservationId: string }>(claimUploadCleanup)(ctx, { reservationId: row._id })
  );
  assert.equal(claim, null);
  assert.equal(f.database.rows("uploadReservations")[0]!["nextAttemptAt"], Number.MAX_SAFE_INTEGER);
  assert.equal(f.database.rows("accountStorageUsage")[0]!["usedBytes"], exactBytes.length);
  const after = await f.upload({ request: request() });
  assert.equal(after.status, 409);
  assert.equal((await after.json()).outcome, "failed");
  assert.equal(f.state.uploads, 0);
});

test("provider may store bytes then lose response; document failure is fenced but storage stays charged", async (t) => {
  const f = await fixture(t);
  f.state.providerLost = true;
  const response = await f.upload({ request: request() });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).outcome, "failed");
  assert.equal(f.database.rows("documents").length, 0);
  const reservation = f.database.rows("uploadReservations")[0]!;
  assert.equal(reservation["cleanupRequested"], true);
  assert.equal(reservation["uploadConfirmed"], false);
  assert.deepEqual(await f.storage.read(String(reservation["storageKey"])), exactBytes);
  assert.equal((await f.upload({ request: request() })).status, 409);
  assert.equal(f.state.uploads, 1);
});

test("lost commit and fence responses settle through the durable receipt without deleting committed bytes", async (t) => {
  const f = await fixture(t);
  f.state.commitLost = true;
  f.state.abandonLost = true;
  const response = await f.upload({ request: request() });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "committed");
  assert.equal(f.database.rows("documents")[0]!._id, body.id);
  assert.equal(f.database.rows("uploadReservations").length, 0);
  assert.equal(f.state.uploads, 1);
});

test("unavailable backend after possible commit is unknown, then authenticated lookup recovers success", async (t) => {
  const f = await fixture(t);
  f.state.commitLost = true;
  f.state.abandonLost = true;
  f.state.unavailable = true;
  const response = await f.upload({ request: request() });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.outcome, "unknown");
  assert.equal(body.operation.accountId, "owner-a");
  assert.equal(body.receipt, undefined, "cannot fabricate a persisted receipt");
  f.state.unavailable = false;
  assert.equal((await f.lookup({ request: lookupRequest() })).status, 200);
  assert.equal((await f.upload({ request: request() })).status, 200);
  assert.equal(f.state.uploads, 1);
});

test("confirmed upload followed by commit refusal fences failure and releases quota only after real deletion", async (t) => {
  const f = await fixture(t);
  f.state.commitRejected = true;
  const response = await f.upload({ request: request() });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).outcome, "failed");
  const reservation = f.database.rows("uploadReservations")[0]!;
  await f.database.transaction((ctx) =>
    ctx.db.patch(reservation._id as Id<"uploadReservations">, { nextAttemptAt: 0 })
  );
  const claim = await f.database.transaction((ctx) =>
    handlerOf<{ reservationId: string }>(claimUploadCleanup)(ctx, {
      reservationId: reservation._id,
    })
  );
  assert.equal((claim as { attempts: number }).attempts, 1);
  await f.storage.delete(String(reservation["storageKey"]));
  await f.database.transaction((ctx) =>
    handlerOf<{ reservationId: string; attempts: number }>(finishUploadCleanup)(ctx, {
      reservationId: reservation._id,
      attempts: 1,
    })
  );
  assert.equal(f.database.rows("accountStorageUsage")[0]!["usedBytes"], 0);
  assert.equal(f.database.rows("uploadReceipts")[0]!["status"], "failed");
  f.state.commitRejected = false;
  assert.equal((await f.upload({ request: request() })).status, 409);
  assert.equal(f.state.uploads, 1);
});

test("quota refusal is durable for the key and different content still conflicts", async (t) => {
  const f = await fixture(t);
  process.env["ACCOUNT_STORAGE_QUOTA_BYTES"] = "1";
  const response = await f.upload({ request: request() });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).receipt.failureCode, "STORAGE_QUOTA_EXCEEDED");
  assert.equal(f.state.uploads, 0);
  assert.equal(f.database.rows("uploadReservations").length, 0);
  process.env["ACCOUNT_STORAGE_QUOTA_BYTES"] = "100000";
  assert.equal((await f.upload({ request: request() })).status, 409);
  const changed = await f.upload({ request: request({ title: "changed" }) });
  assert.equal((await changed.json()).code, "UPLOAD_OPERATION_CONFLICT");
});

test("cloud deletion does not erase the operation outcome or permit recreation", async (t) => {
  const f = await fixture(t);
  const body = await (await f.upload({ request: request() })).json();
  const row = f.database.rows("documents")[0]!;
  await f.database.transaction((ctx) => requestDeletionForOwner(ctx, "owner-a", body.id));
  const job = f.database.rows("deletionJobs")[0]!;
  await f.storage.delete(String(row["storageKey"]));
  await f.database.transaction((ctx) =>
    handlerOf<{ jobId: string; attempts: number }>(finishDeletion)(ctx, {
      jobId: job._id,
      attempts: 0,
    })
  );
  assert.equal(f.database.rows("documents").length, 0);
  const replay = await (await f.upload({ request: request() })).json();
  assert.equal(replay.id, body.id);
  assert.equal(replay.receipt.status, "committed");
  assert.equal(f.state.uploads, 1);
  assert.equal(f.database.rows("accountStorageUsage")[0]!["usedBytes"], 0);
});

test("legacy uploads remain unkeyed and compatible; malformed keys or foreign origins never admit", async (t) => {
  const f = await fixture(t);
  for (const key of ["", "short", "a".repeat(129), "key,with,commas___"]) {
    assert.equal((await f.upload({ request: request({ key }) })).status, 400);
  }
  assert.equal(
    (await f.upload({ request: request({ origin: "https://foreign.example" }) })).status,
    400
  );
  assert.equal(f.database.rows("uploadReceipts").length, 0);
  const legacy = await f.upload({ request: request({ key: null }) });
  assert.equal(legacy.status, 201);
  assert.deepEqual(Object.keys(await legacy.json()), ["id"]);
  assert.equal((await f.upload({ request: request({ key: null }) })).status, 201);
  assert.equal(f.database.rows("documents").length, 2);
  assert.equal(f.database.rows("uploadReceipts").length, 0);
});

test("signed operation fields cannot be changed or dropped; legacy commit cannot bypass receipt fencing", async (t) => {
  const f = await fixture(t);
  f.state.reserveLost = true;
  await f.upload({ request: request() });
  const receipt = f.database.rows("uploadReceipts")[0]!;
  const operation = fingerprintUpload({
    key: operationKey,
    origin,
    title: "Exact title",
    contentType: "text/html",
    bytes: exactBytes,
  });
  const metadata = {
    title: "Exact title",
    contentType: "text/html" as const,
    sizeBytes: exactBytes.length,
    storageProvider: "filesystem" as const,
    storageKey: String(receipt["storageKey"]),
    operation,
  };
  const args = await f.signed(metadata, "owner-a");
  for (const changed of [
    { ...operation, origin: "https://other.example" },
    { ...operation, key: "other_operation_0001" },
    { ...operation, contentSha256: "b".repeat(64) },
    { ...operation, fingerprint: "c".repeat(64) },
  ]) {
    assert.equal(
      await verifyCreateDocumentProof(
        secret,
        { ownerId: "owner-a", ...metadata, operation: changed },
        args.proof
      ),
      false
    );
  }
  const { operation: _op, ...legacyMetadata } = metadata;
  const legacy = await f.signed(legacyMetadata, "owner-a");
  await assert.rejects(
    f.database.transaction((ctx) => createForOwner(ctx, "owner-a", legacy)),
    /receipt is required/
  );
  await assert.rejects(
    f.database.transaction((ctx) => reserveUploadForOwner(ctx, "owner-a", legacy)),
    /receipt is required/
  );
  const outcomeProof = await signAbandonDocumentProof(secret, {
    ownerId: "owner-a",
    ...metadata,
    uploadConfirmed: false,
  });
  assert.equal(
    await verifyAbandonDocumentProof(
      secret,
      {
        ownerId: "owner-a",
        ...metadata,
        operation: { ...operation, key: "changed_operation_0001" },
        uploadConfirmed: false,
      },
      outcomeProof
    ),
    false
  );
});

test("receipt lookup rechecks browser owner and upload-only credential ownership and revocation", async (t) => {
  const f = await fixture(t);
  await f.upload({ request: request() });
  const tokenHash = "a".repeat(64);
  const credentialId = await f.database.transaction((ctx) =>
    ctx.db.insert("cliCredentials", {
      ownerId: "owner-b",
      tokenHash,
      createdAt: 1,
    })
  );
  const input = { key: operationKey, origin, tokenHash };
  assert.equal(
    await f.database.transaction((ctx) =>
      handlerOf<typeof input>(uploadReceiptWithCliCredential)(ctx, input)
    ),
    null
  );
  await f.database.transaction((ctx) => ctx.db.patch(credentialId, { ownerId: "owner-a" }));
  assert.equal(
    (
      (await f.database.transaction((ctx) =>
        handlerOf<typeof input>(uploadReceiptWithCliCredential)(ctx, input)
      )) as { status: string }
    ).status,
    "committed"
  );
  await f.database.transaction((ctx) => ctx.db.patch(credentialId, { revokedAt: 1 }));
  await assert.rejects(
    f.database.transaction((ctx) =>
      handlerOf<typeof input>(uploadReceiptWithCliCredential)(ctx, input)
    ),
    /revoked/
  );
  assert.ok(
    await f.database.transaction((ctx) => handlerOf<typeof input>(uploadReceipt)(ctx, input))
  );
  const unauthenticated = createUploadReceiptHandler({
    ...f.dependencies,
    getAuthedClient: async () => ({ client: {}, token: null }),
  });
  assert.equal((await unauthenticated({ request: lookupRequest() })).status, 401);
});

test("simultaneous first admissions retry the transaction and allocate exactly one receipt, reservation and quota charge", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => f.upload({ request: request() }))
  );
  const committed = await Promise.all(
    responses.filter((response) => response.status !== 202).map((response) => response.json())
  );
  assert.ok(committed.length > 0);
  assert.equal(new Set(committed.map((body) => body.id)).size, 1);
  assert.equal(f.state.uploads, 1);
  assert.equal(f.database.rows("uploadReceipts").length, 1);
  assert.equal(f.database.rows("documents").length, 1);
  assert.equal(f.database.rows("accountStorageUsage")[0]!["usedBytes"], exactBytes.length);
  assert.equal(f.database.scheduled.length, 1);
});

test("interruption after provider success and before commit acknowledgement stays pending when fencing is unavailable", async (t) => {
  const f = await fixture(t);
  f.state.commitRejected = true;
  f.state.abandonLost = true;
  const response = await f.upload({ request: request() });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).outcome, "unknown");
  const row = f.database.rows("uploadReservations")[0]!;
  assert.deepEqual(await f.storage.read(String(row["storageKey"])), exactBytes);
  assert.equal(f.database.rows("documents").length, 0);
  assert.equal((await f.upload({ request: request() })).status, 202);
  assert.equal(f.state.uploads, 1);
});

test("commit versus cancellation race yields one terminal receipt and never resurrects a fenced operation", async (t) => {
  const f = await fixture(t);
  f.state.reserveLost = true;
  await f.upload({ request: request() });
  const row = f.database.rows("uploadReceipts")[0]!;
  const metadata = {
    title: "Exact title",
    contentType: "text/html" as const,
    sizeBytes: exactBytes.length,
    storageProvider: "filesystem" as const,
    storageKey: String(row["storageKey"]),
    operation: fingerprintUpload({
      key: operationKey,
      origin,
      title: "Exact title",
      contentType: "text/html",
      bytes: exactBytes,
    }),
  };
  const signed = await f.signed(metadata, "owner-a");
  const cancellation = {
    ...signed,
    uploadConfirmed: true,
    outcomeProof: await signAbandonDocumentProof(secret, {
      ownerId: "owner-a",
      ...metadata,
      uploadConfirmed: true,
    }),
  };
  await Promise.allSettled([
    f.database.transaction((ctx) => createForOwner(ctx, "owner-a", signed)),
    f.database.transaction((ctx) => abandonUploadForOwner(ctx, "owner-a", cancellation)),
  ]);
  const receipt = f.database.rows("uploadReceipts")[0]!;
  if (receipt["status"] === "committed") {
    assert.equal(f.database.rows("documents").length, 1);
    assert.equal(f.database.rows("uploadReservations").length, 0);
    assert.equal(
      await f.database.transaction((ctx) => abandonUploadForOwner(ctx, "owner-a", cancellation)),
      receipt["documentId"]
    );
  } else {
    assert.equal(receipt["status"], "failed");
    assert.equal(f.database.rows("documents").length, 0);
    await assert.rejects(
      f.database.transaction((ctx) => createForOwner(ctx, "owner-a", signed)),
      /failed/
    );
  }
});

test("receipt admission rolls back with reservation scheduling failure and never falsely claims failure", async (t) => {
  const f = await fixture(t);
  const metadata = {
    title: "Exact title",
    contentType: "text/html" as const,
    sizeBytes: exactBytes.length,
    ...f.storage.getUploadLocator(`owner-a:${randomUUID()}`),
    operation: fingerprintUpload({
      key: operationKey,
      origin,
      title: "Exact title",
      contentType: "text/html",
      bytes: exactBytes,
    }),
  };
  const signed = await f.signed(metadata, "owner-a");
  await assert.rejects(
    f.database.transaction((ctx) => {
      ctx.scheduler.runAfter = async () => {
        throw new Error("scheduler failure");
      };
      return reserveUploadForOwner(ctx, "owner-a", signed);
    }),
    /scheduler failure/
  );
  assert.equal(f.database.rows("uploadReceipts").length, 0);
  assert.equal(f.database.rows("uploadReservations").length, 0);
  assert.equal(f.database.rows("accountStorageUsage").length, 0);
  assert.equal((await f.lookup({ request: lookupRequest() })).status, 404);
});

test("lost admission response cannot misreport a different existing fingerprint as success", async (t) => {
  const f = await fixture(t);
  await f.upload({ request: request() });
  const handler = createDocumentUploadHandler({
    ...f.dependencies,
    reserveMetadata: async () => {
      throw new Error("transport failed before observing conflict");
    },
  });
  const response = await handler({
    request: request({ bytes: new Uint8Array(exactBytes).fill(0x62) }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "UPLOAD_OPERATION_CONFLICT");
  assert.equal(f.state.uploads, 1);
});
