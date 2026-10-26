import assert from "node:assert/strict";
import { test } from "node:test";

import {
  accountStorageQuotaBytes,
  defaultAccountStorageQuotaBytes,
} from "../convex/storageQuota.ts";
import { signCreateDocumentProof, signAbandonDocumentProof } from "../convex/documentProof.ts";
import {
  reserveUploadForOwner,
  reserveUpload,
  reserveUploadWithCliCredential,
  createForOwner,
  abandonUploadForOwner,
  claimUploadCleanup,
  finishUploadCleanup,
  deferUploadCleanup,
  finishDeletion,
} from "../convex/documents.ts";
import { reserveUpload as reserveMcpUpload } from "../convex/mcpDocuments.ts";
import { signMcpDocumentProof } from "../convex/mcpProof.ts";
import type { MutationCtx } from "../convex/_generated/server.js";

const secret = "quota-test-secret-with-at-least-32-bytes";
import { memoryDatabase, type Row } from "./fixtures/memory-database.mts";

const firstRow = (rows: Row[]) => {
  const row = rows[0];
  assert.ok(row);
  return row;
};

const mutationHandler = <Args,>(fn: unknown) =>
  (fn as { _handler(ctx: MutationCtx, args: Args): Promise<unknown> })._handler;

async function withQuota<T>(operation: () => Promise<T>) {
  const previousQuota = process.env["ACCOUNT_STORAGE_QUOTA_BYTES"];
  const previousSecret = process.env["DOCUMENT_MUTATION_SECRET"];
  process.env["ACCOUNT_STORAGE_QUOTA_BYTES"] = "100";
  process.env["DOCUMENT_MUTATION_SECRET"] = secret;
  try {
    return await operation();
  } finally {
    if (previousQuota === undefined) delete process.env["ACCOUNT_STORAGE_QUOTA_BYTES"];
    else process.env["ACCOUNT_STORAGE_QUOTA_BYTES"] = previousQuota;
    if (previousSecret === undefined) delete process.env["DOCUMENT_MUTATION_SECRET"];
    else process.env["DOCUMENT_MUTATION_SECRET"] = previousSecret;
  }
}

const input = async (
  key: string,
  sizeBytes: number,
  ownerId = "owner-a",
  contentType = "text/html"
) => {
  const metadata = {
    ownerId,
    title: "Plan",
    storageProvider: "uploadthing",
    storageKey: `uploadthing-custom-id:${ownerId}:${key}`,
    contentType,
    sizeBytes,
  };
  return {
    ...metadata,
    proof: await signCreateDocumentProof(secret, metadata),
    uploadConfirmed: true,
    outcomeProof: await signAbandonDocumentProof(secret, { ...metadata, uploadConfirmed: true }),
  };
};

test("quota defaults to 500 decimal MB and rejects unsafe configuration", () => {
  assert.equal(defaultAccountStorageQuotaBytes, 500_000_000);
  assert.equal(accountStorageQuotaBytes("500000000"), defaultAccountStorageQuotaBytes);
  for (const value of ["0", "1.5", "9007199254740992"]) {
    assert.throws(() => accountStorageQuotaBytes(value), /positive integer/);
  }
});

test("concurrent uploads cannot reserve more than the account limit", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const first = await input("first", 60);
    const second = await input("second", 60);
    const results = await Promise.allSettled([
      database.transaction((ctx) => reserveUploadForOwner(ctx, first.ownerId, first)),
      database.transaction((ctx) => reserveUploadForOwner(ctx, second.ownerId, second)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.equal(rejected.reason.data.code, "STORAGE_QUOTA_EXCEEDED");
    assert.equal(database.rows("uploadReservations").length, 1);
    assert.equal(database.rows("accountStorageUsage").length, 1);
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 60);
    assert.equal(database.scheduled.length, 1, "retries do not duplicate cleanup scheduling");
  }));

test("existing and pending-deletion bytes count, and other owners remain independent", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    await database.transaction(async (ctx) => {
      await ctx.db.insert("documents", {
        ownerId: "owner-a",
        title: "Old",
        contentType: "text/html",
        sizeBytes: 80,
        createdAt: 1,
        updatedAt: 1,
        deletionRequestedAt: 2,
      });
    });
    const request = await input("new", 21);
    await assert.rejects(
      database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request)),
      /storage limit/
    );
    const foreign = await input("foreign", 100, "owner-b");
    await database.transaction((ctx) => reserveUploadForOwner(ctx, foreign.ownerId, foreign));
    assert.equal(database.rows("uploadReservations").length, 1);
  }));

test("commit exchanges one reservation for metadata and ambiguous success remains safe", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const request = await input("new", 100, "owner-a", "application/vnd.planview.bundle");
    await assert.rejects(
      database.transaction((ctx) => createForOwner(ctx, request.ownerId, request)),
      /reservation/
    );
    await database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request));
    const id = await database.transaction((ctx) => createForOwner(ctx, request.ownerId, request));
    assert.equal(database.rows("uploadReservations").length, 0);
    assert.equal(database.rows("documents").length, 1);
    assert.equal(firstRow(database.rows("documents"))["contentType"], request.contentType);
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 100);
    assert.equal(
      await database.transaction((ctx) => createForOwner(ctx, request.ownerId, request)),
      id
    );
    assert.equal(
      await database.transaction((ctx) => abandonUploadForOwner(ctx, request.ownerId, request)),
      id
    );
    const reservation = await database.transaction((ctx) =>
      reserveUploadForOwner(ctx, request.ownerId, request)
    );
    assert.equal(reservation.id, id);
    const extra = await input("extra", 1);
    await assert.rejects(
      database.transaction((ctx) => reserveUploadForOwner(ctx, extra.ownerId, extra)),
      /storage limit/
    );
  }));

test("failed uploads stay charged until cleanup succeeds, and cannot commit after fencing", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const request = await input("failed", 100);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request));
    await database.transaction((ctx) => abandonUploadForOwner(ctx, request.ownerId, request));
    await assert.rejects(
      database.transaction((ctx) => createForOwner(ctx, request.ownerId, request)),
      /reservation/
    );
    const extra = await input("extra", 1);
    await assert.rejects(
      database.transaction((ctx) => reserveUploadForOwner(ctx, extra.ownerId, extra)),
      /storage limit/
    );
    const reservationId = firstRow(database.rows("uploadReservations"))._id;
    await database.transaction((ctx) => ctx.db.patch(reservationId as never, { nextAttemptAt: 0 }));
    const claim = await database.transaction((ctx) =>
      mutationHandler<{ reservationId: string }>(claimUploadCleanup)(ctx, { reservationId })
    );
    assert.equal((claim as { attempts: number }).attempts, 1);
    await database.transaction((ctx) =>
      mutationHandler<{ reservationId: string; attempts: number }>(deferUploadCleanup)(ctx, {
        reservationId,
        attempts: 1,
      })
    );
    assert.equal(
      database.rows("uploadReservations").length,
      1,
      "provider failures retain charged capacity"
    );
    await database.transaction((ctx) =>
      mutationHandler<{ reservationId: string; attempts: number }>(finishUploadCleanup)(ctx, {
        reservationId,
        attempts: 0,
      })
    );
    assert.equal(
      database.rows("uploadReservations").length,
      1,
      "stale cleanup completions cannot release capacity"
    );
    await database.transaction((ctx) =>
      mutationHandler<{ reservationId: string; attempts: number }>(finishUploadCleanup)(ctx, {
        reservationId,
        attempts: 1,
      })
    );
    assert.equal(database.rows("uploadReservations").length, 0);
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 0);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, extra.ownerId, extra));
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 1);
  }));

test("document bytes are released only after storage deletion is completed", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const request = await input("existing", 100);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request));
    const id = await database.transaction((ctx) => createForOwner(ctx, request.ownerId, request));
    let jobId: string | undefined;
    await database.transaction(async (ctx) => {
      await ctx.db.patch(id, { deletionRequestedAt: Date.now() });
      jobId = await ctx.db.insert("deletionJobs", {
        documentId: id,
        storageKey: request.storageKey,
        nextAttemptAt: 0,
        attempts: 1,
      });
    });
    const extra = await input("extra", 1);
    await assert.rejects(
      database.transaction((ctx) => reserveUploadForOwner(ctx, extra.ownerId, extra)),
      /storage limit/
    );
    await database.transaction((ctx) =>
      mutationHandler<{ jobId: string; attempts: number }>(finishDeletion)(ctx, {
        jobId: jobId ?? "missing-job",
        attempts: 1,
      })
    );
    await database.transaction((ctx) => reserveUploadForOwner(ctx, extra.ownerId, extra));
  }));

test("reservations bind exact owner, size, and title and expired uploads cannot commit", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const request = await input("new", 50);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request));
    const changed = await input("new", 51);
    await assert.rejects(
      database.transaction((ctx) => createForOwner(ctx, request.ownerId, changed)),
      /reservation/
    );
    await assert.rejects(
      database.transaction((ctx) => reserveUploadForOwner(ctx, "owner-b", request)),
      /metadata/
    );
    const reservationId = firstRow(database.rows("uploadReservations"))._id;
    await database.transaction((ctx) =>
      ctx.db.patch(reservationId as never, { uploadDeadlineAt: 0 })
    );
    await assert.rejects(
      database.transaction((ctx) => createForOwner(ctx, request.ownerId, request)),
      /reservation/
    );
  }));

test("unknown provider outcomes remain charged and never enter automatic storage cleanup", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const request = await input("unknown", 100);
    const uploadConfirmed = false;
    const unknown = {
      ...request,
      uploadConfirmed,
      outcomeProof: await signAbandonDocumentProof(secret, { ...request, uploadConfirmed }),
    };
    await database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request));
    await database.transaction((ctx) => abandonUploadForOwner(ctx, request.ownerId, unknown));
    const reservationId = firstRow(database.rows("uploadReservations"))._id;
    await database.transaction((ctx) => ctx.db.patch(reservationId as never, { nextAttemptAt: 0 }));
    const claim = await database.transaction((ctx) =>
      mutationHandler<{ reservationId: string }>(claimUploadCleanup)(ctx, { reservationId })
    );
    assert.equal(claim, null, "worker must not delete possibly in-flight bytes");
    assert.equal(
      firstRow(database.rows("uploadReservations"))["nextAttemptAt"],
      Number.MAX_SAFE_INTEGER
    );
    const extra = await input("extra", 1);
    await assert.rejects(
      database.transaction((ctx) => reserveUploadForOwner(ctx, extra.ownerId, extra)),
      /storage limit/
    );
    await assert.rejects(
      database.transaction((ctx) =>
        abandonUploadForOwner(ctx, request.ownerId, { ...unknown, uploadConfirmed: true })
      ),
      /outcome proof/
    );
  }));

test("cleanup claiming and commit racing preserve either committed metadata or fenced reservation", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const request = await input("race", 100);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request));
    const results = await Promise.allSettled([
      database.transaction((ctx) => createForOwner(ctx, request.ownerId, request)),
      database.transaction((ctx) => abandonUploadForOwner(ctx, request.ownerId, request)),
    ]);
    const documents = database.rows("documents");
    if (documents.length) {
      assert.equal(database.rows("uploadReservations").length, 0);
      const cancellation = results[1];
      assert.equal(cancellation?.status, "fulfilled");
      assert.equal(
        cancellation?.status === "fulfilled" ? cancellation.value : null,
        firstRow(documents)._id
      );
    } else {
      assert.equal(firstRow(database.rows("uploadReservations"))["cleanupRequested"], true);
      assert.equal(results[0]?.status, "rejected");
    }
  }));

test("existing bytes seed once and subsequent admissions read only the owner counter", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    await database.transaction(async (ctx) => {
      await ctx.db.insert("documents", {
        ownerId: "owner-a",
        title: "Legacy",
        contentType: "text/html",
        sizeBytes: 80,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const first = await input("first", 10);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, first.ownerId, first));
    assert.deepEqual(database.fullScans, ["documents", "uploadReservations"]);
    const second = await input("second", 10);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, second.ownerId, second));
    assert.deepEqual(
      database.fullScans,
      ["documents", "uploadReservations"],
      "normal admissions never rescan document collections"
    );
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 100);
  }));

test("concurrent first admissions seed legacy bytes exactly once", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    await database.transaction(async (ctx) => {
      await ctx.db.insert("documents", {
        ownerId: "owner-a",
        title: "Legacy",
        contentType: "text/html",
        sizeBytes: 80,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const first = await input("first", 10);
    const second = await input("second", 10);
    await Promise.all([
      database.transaction((ctx) => reserveUploadForOwner(ctx, first.ownerId, first)),
      database.transaction((ctx) => reserveUploadForOwner(ctx, second.ownerId, second)),
    ]);
    assert.equal(database.rows("accountStorageUsage").length, 1);
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 100);
    assert.equal(database.rows("uploadReservations").length, 2);
  }));

test("reservation transaction failure rolls back both its counter and metadata", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const first = await input("first", 10);
    await assert.rejects(
      database.transaction((ctx) => {
        Object.assign(ctx.scheduler, {
          runAfter: async () => {
            throw new Error("scheduler unavailable");
          },
        });
        return reserveUploadForOwner(ctx, first.ownerId, first);
      }),
      /scheduler unavailable/
    );
    assert.equal(database.rows("accountStorageUsage").length, 0);
    assert.equal(database.rows("uploadReservations").length, 0);
    await database.transaction((ctx) => reserveUploadForOwner(ctx, first.ownerId, first));
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 10);
  }));

test("browser, upload-only CLI credentials, and MCP enforce the same transactional account quota", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    const tokenHash = "a".repeat(64);
    await database.transaction(async (ctx) => {
      await ctx.db.insert("cliCredentials", { ownerId: "owner-a", tokenHash, createdAt: 1 });
    });
    const browser = await input("browser", 60);
    await database.transaction((ctx) =>
      mutationHandler<typeof browser>(reserveUpload)(ctx, browser)
    );
    const cli = await input("cli", 60);
    await assert.rejects(
      database.transaction((ctx) =>
        mutationHandler<typeof cli & { tokenHash: string }>(reserveUploadWithCliCredential)(ctx, {
          ...cli,
          tokenHash,
        })
      ),
      /storage limit/
    );
    const mcp = await input("mcp", 60);
    const mcpArguments = {
      ...mcp,
      createProof: mcp.proof,
      proof: await signMcpDocumentProof(secret, {
        action: "reserve",
        ownerId: mcp.ownerId,
        arguments: [mcp.title, mcp.storageProvider, mcp.storageKey, mcp.contentType, mcp.sizeBytes],
      }),
    };
    await assert.rejects(
      database.transaction((ctx) =>
        mutationHandler<typeof mcpArguments>(reserveMcpUpload)(ctx, mcpArguments)
      ),
      /storage limit/
    );
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 60);
    assert.equal(database.rows("uploadReservations").length, 1);
  }));

test("legacy deletion and first upload share one seeded counter without drift", async () =>
  withQuota(async () => {
    const database = memoryDatabase();
    let jobId = "";
    await database.transaction(async (ctx) => {
      const id = await ctx.db.insert("documents", {
        ownerId: "owner-a",
        title: "Legacy",
        contentType: "text/html",
        sizeBytes: 80,
        createdAt: 1,
        updatedAt: 1,
        deletionRequestedAt: 2,
      });
      jobId = await ctx.db.insert("deletionJobs", {
        documentId: id,
        storageKey: "legacy-file-key",
        nextAttemptAt: 0,
        attempts: 1,
      });
    });
    const request = await input("new", 20);
    await Promise.all([
      database.transaction((ctx) =>
        mutationHandler<{ jobId: string; attempts: number }>(finishDeletion)(ctx, {
          jobId,
          attempts: 1,
        })
      ),
      database.transaction((ctx) => reserveUploadForOwner(ctx, request.ownerId, request)),
    ]);
    assert.equal(database.rows("documents").length, 0);
    assert.equal(database.rows("accountStorageUsage").length, 1);
    assert.equal(firstRow(database.rows("accountStorageUsage"))["usedBytes"], 20);
    await database.transaction((ctx) =>
      mutationHandler<{ jobId: string; attempts: number }>(finishDeletion)(ctx, {
        jobId,
        attempts: 1,
      })
    );
    assert.equal(
      firstRow(database.rows("accountStorageUsage"))["usedBytes"],
      20,
      "repeated completion never subtracts twice"
    );
  }));
