import { ConvexError, v } from "convex/values";
import { makeFunctionReference, paginationOptsValidator } from "convex/server";

import {
  assertReceiptMatches,
  findReceipt,
  operationValidator,
  publicReceipt,
  receiptLookupArgs,
  validateOperation,
  validateReceiptLookup,
} from "./uploadReceipt.ts";
import type { UploadReceipt } from "./uploadReceipt.ts";
import type { UploadOperation } from "./documentProof.ts";
import type { UploadReservation } from "./uploadReceipt.ts";

import type { Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import {
  verifyCreateDocumentProof,
  verifyAbandonDocumentProof,
  type DocumentMutationProof,
} from "./documentProof.ts";

import {
  reserveAccountBytes,
  releaseAccountBytes,
  uploadLifetimeMs,
  uploadCleanupGraceMs,
} from "./storageQuota.ts";

import { isLocalDevelopment, isFilesystemKey } from "./localMode.ts";
import {
  cloudDocumentMaxBytes,
  cloudDocumentTitleMaxLength,
  cloudDocumentTitleMinLength,
} from "@planview/core/cloud-policy";

const uploadThingLocatorPrefix = (ownerId: string) => `uploadthing-custom-id:${ownerId}:`;
const maxHtmlSizeBytes = cloudDocumentMaxBytes;
const proofValidator = v.object({ expiresAt: v.number(), signature: v.string() });
const createArgs = {
  title: v.string(),
  storageProvider: v.string(),
  storageKey: v.string(),
  contentType: v.string(),
  sizeBytes: v.number(),
  proof: proofValidator,
  operation: v.optional(operationValidator),
};
type CreateArgs = {
  operation?: UploadOperation;
  title: string;
  storageProvider: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  proof: DocumentMutationProof;
};
const abandonArgs = { ...createArgs, uploadConfirmed: v.boolean(), outcomeProof: proofValidator };
type AbandonArgs = CreateArgs & { uploadConfirmed: boolean; outcomeProof: DocumentMutationProof };

const deletionWorker = makeFunctionReference<"action", { jobId: Id<"deletionJobs"> }>(
  "documentDeletion:processDeletion"
);
const uploadCleanupWorker = makeFunctionReference<
  "action",
  { reservationId: Id<"uploadReservations"> }
>("documentDeletion:processAbandonedUpload");
const deletionLeaseMs = 11 * 60_000;

export const deletionRetryDelay = (attempts: number) =>
  Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7));

const requireMutationSecret = () => {
  const secret = process.env["DOCUMENT_MUTATION_SECRET"];
  if (!secret || new TextEncoder().encode(secret).length < 32) {
    throw new Error("Document mutation signing is not configured");
  }
  return secret;
};

const requireOwnerId = async (ctx: {
  auth: { getUserIdentity: () => Promise<{ subject: string } | null> };
}) => {
  const identity = await ctx.auth.getUserIdentity();

  if (!identity) {
    throw new Error("Authentication required");
  }

  return identity.subject;
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await requireOwnerId(ctx);

    return await ctx.db
      .query("documents")
      .withIndex("by_owner_active_createdAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletionRequestedAt", undefined)
      )
      .order("desc")
      .take(100);
  },
});

export const listPage = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    if (
      !Number.isSafeInteger(paginationOpts.numItems) ||
      paginationOpts.numItems < 1 ||
      paginationOpts.numItems > 100
    ) {
      throw new Error("Page size must be between 1 and 100");
    }
    const ownerId = await requireOwnerId(ctx);

    return await ctx.db
      .query("documents")
      .withIndex("by_owner_active_createdAt", (q) =>
        q.eq("ownerId", ownerId).eq("deletionRequestedAt", undefined)
      )
      .order("desc")
      .paginate(paginationOpts);
  },
});

export const verifyUploadInput = async (ownerId: string, args: CreateArgs) => {
  if (args.operation) validateOperation(args.operation);
  const validLocator =
    args.storageProvider === "uploadthing"
      ? args.storageKey.startsWith(uploadThingLocatorPrefix(ownerId)) &&
        args.storageKey.length > uploadThingLocatorPrefix(ownerId).length
      : args.storageProvider === "filesystem" &&
        isLocalDevelopment(process.env) &&
        isFilesystemKey(args.storageKey, ownerId);
  if (
    !validLocator ||
    (args.contentType !== "text/html" && args.contentType !== "application/vnd.planview.bundle") ||
    args.title.trim().length < cloudDocumentTitleMinLength ||
    args.title.length > cloudDocumentTitleMaxLength ||
    !Number.isSafeInteger(args.sizeBytes) ||
    args.sizeBytes < 0 ||
    args.sizeBytes > maxHtmlSizeBytes
  ) {
    throw new Error("Invalid document metadata");
  }

  const validProof = await verifyCreateDocumentProof(
    requireMutationSecret(),
    {
      ownerId,
      title: args.title,
      storageProvider: args.storageProvider,
      storageKey: args.storageKey,
      contentType: args.contentType,
      sizeBytes: args.sizeBytes,
      ...(args.operation ? { operation: args.operation } : {}),
    },
    args.proof
  );
  if (!validProof) throw new Error("Invalid document mutation proof");
};

const findStoredDocument = (ctx: MutationCtx, ownerId: string, storageKey: string) =>
  ctx.db
    .query("documents")
    .withIndex("by_owner_storageKey", (q) => q.eq("ownerId", ownerId).eq("storageKey", storageKey))
    .first();

const findUploadReservation = (ctx: MutationCtx, ownerId: string, storageKey: string) =>
  ctx.db
    .query("uploadReservations")
    .withIndex("by_owner_storageKey", (q) => q.eq("ownerId", ownerId).eq("storageKey", storageKey))
    .first();

const reservationMatches = (reservation: { title: string; sizeBytes: number }, args: CreateArgs) =>
  reservation.title === args.title.trim() && reservation.sizeBytes === args.sizeBytes;

export const reserveUploadForOwner = async (
  ctx: MutationCtx,
  ownerId: string,
  args: CreateArgs
): Promise<UploadReservation> => {
  await verifyUploadInput(ownerId, args);
  if (args.operation) {
    const receipt = await findReceipt(ctx, ownerId, args.operation);
    if (receipt) {
      assertReceiptMatches(receipt, args.operation);
      return {
        id: receipt.documentId ?? null,
        uploadDeadlineAt: 0,
        receipt: publicReceipt(receipt),
        admitted: false,
      };
    }
  }
  const document = await findStoredDocument(ctx, ownerId, args.storageKey);
  if (document) {
    if (document.deletionRequestedAt !== undefined) throw new Error("Document is being deleted");
    return { id: document._id, uploadDeadlineAt: 0 };
  }
  const reservation = await findUploadReservation(ctx, ownerId, args.storageKey);
  if (reservation) {
    if (reservation.receiptId) throw new Error("Upload receipt is required");
    if (
      !reservationMatches(reservation, args) ||
      reservation.cleanupRequested ||
      reservation.uploadDeadlineAt <= Date.now()
    ) {
      throw new Error("Upload reservation is no longer available");
    }
    return { id: null, uploadDeadlineAt: reservation.uploadDeadlineAt };
  }
  try {
    await reserveAccountBytes(ctx, ownerId, args.sizeBytes);
  } catch (error) {
    if (
      !args.operation ||
      !(error instanceof ConvexError) ||
      typeof error.data !== "object" ||
      error.data === null ||
      Array.isArray(error.data) ||
      error.data.code !== "STORAGE_QUOTA_EXCEEDED"
    )
      throw error;
    const id = await ctx.db.insert("uploadReceipts", {
      ownerId,
      ...args.operation,
      storageKey: args.storageKey,
      status: "failed",
      failureCode: "STORAGE_QUOTA_EXCEEDED",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    return {
      id: null,
      uploadDeadlineAt: 0,
      receipt: publicReceipt((await ctx.db.get(id))!),
      admitted: false,
    };
  }
  const receiptId = args.operation
    ? await ctx.db.insert("uploadReceipts", {
        ownerId,
        ...args.operation,
        storageKey: args.storageKey,
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    : undefined;
  const uploadDeadlineAt = Date.now() + uploadLifetimeMs;
  const nextAttemptAt = uploadDeadlineAt + uploadCleanupGraceMs;
  const reservationId = await ctx.db.insert("uploadReservations", {
    ...(receiptId ? { receiptId } : {}),
    ownerId,
    title: args.title.trim(),
    storageKey: args.storageKey,
    storageProvider: args.storageProvider,
    sizeBytes: args.sizeBytes,
    uploadDeadlineAt,
    nextAttemptAt,
    cleanupRequested: false,
    uploadConfirmed: false,
    attempts: 0,
  });
  await ctx.scheduler.runAfter(uploadLifetimeMs + uploadCleanupGraceMs, uploadCleanupWorker, {
    reservationId,
  });
  return {
    id: null,
    uploadDeadlineAt,
    ...(receiptId
      ? {
          receipt: publicReceipt((await ctx.db.get(receiptId))!),
          admitted: true,
        }
      : {}),
  };
};

const receiptForMutation = async (ctx: MutationCtx, ownerId: string, args: CreateArgs) => {
  if (!args.operation) return null;
  const receipt = await findReceipt(ctx, ownerId, args.operation);
  if (!receipt) throw new Error("Upload receipt is missing");
  assertReceiptMatches(receipt, args.operation);
  if (receipt.storageKey !== args.storageKey) throw new Error("Upload receipt locator mismatch");
  return receipt;
};
const assertReservationReceipt = (
  reservation: { receiptId?: Id<"uploadReceipts"> },
  receipt: { _id: Id<"uploadReceipts"> } | null
) => {
  if (reservation.receiptId !== receipt?._id) throw new Error("Upload receipt is required");
};

export const abandonUploadForOwner = async (
  ctx: MutationCtx,
  ownerId: string,
  args: AbandonArgs
) => {
  await verifyUploadInput(ownerId, args);
  if (
    !(await verifyAbandonDocumentProof(
      requireMutationSecret(),
      { ownerId, ...args },
      args.outcomeProof
    ))
  )
    throw new Error("Invalid upload outcome proof");
  const receipt = await receiptForMutation(ctx, ownerId, args);
  if (receipt?.status === "committed") return receipt.documentId!;
  // A commit can succeed before its response is lost. Check and fence the
  // reservation transactionally before asking the worker to delete anything.
  const document = await findStoredDocument(ctx, ownerId, args.storageKey);
  if (document) return document.deletionRequestedAt === undefined ? document._id : null;
  const reservation = await findUploadReservation(ctx, ownerId, args.storageKey);
  if (reservation) {
    assertReservationReceipt(reservation, receipt);
    if (!reservationMatches(reservation, args)) throw new Error("Invalid upload reservation");
    await ctx.db.patch(reservation._id, {
      cleanupRequested: true,
      uploadConfirmed: args.uploadConfirmed || reservation.uploadConfirmed,
    });
  }
  // The receipt records document failure, not proof that provider bytes are gone.
  // Fencing and this terminal outcome commit together. Unknown ingest remains charged.
  if (receipt) await ctx.db.patch(receipt._id, { status: "failed", updatedAt: Date.now() });
  return null;
};

export const createForOwner = async (ctx: MutationCtx, ownerId: string, args: CreateArgs) => {
  await verifyUploadInput(ownerId, args);
  const receipt = await receiptForMutation(ctx, ownerId, args);
  if (receipt?.status === "committed") return receipt.documentId!;
  if (receipt?.status === "failed") throw new Error("Upload operation has failed");
  const existing = await ctx.db
    .query("documents")
    .withIndex("by_owner_storageKey", (q) =>
      q.eq("ownerId", ownerId).eq("storageKey", args.storageKey)
    )
    .first();
  if (existing) {
    if (existing.deletionRequestedAt !== undefined) {
      throw new Error("Document is being deleted");
    }
    return existing._id;
  }

  const reservation = await findUploadReservation(ctx, ownerId, args.storageKey);
  if (
    !reservation ||
    !reservationMatches(reservation, args) ||
    reservation.cleanupRequested ||
    reservation.uploadDeadlineAt + uploadCleanupGraceMs <= Date.now()
  ) {
    throw new Error("Upload reservation is no longer available");
  }
  assertReservationReceipt(reservation, receipt);
  const now = Date.now();
  const id = await ctx.db.insert("documents", {
    ownerId,
    title: args.title.trim() || "Untitled HTML",
    storageProvider: args.storageProvider,
    storageKey: args.storageKey,
    contentType: args.contentType,
    sizeBytes: args.sizeBytes,
    createdAt: now,
    updatedAt: now,
  });
  if (receipt)
    await ctx.db.patch(receipt._id, { status: "committed", documentId: id, updatedAt: now });
  await ctx.db.delete(reservation._id);
  return id;
};

const requireCliOwnerId = async (ctx: MutationCtx | QueryCtx, tokenHash: string) => {
  if (!/^[a-f0-9]{64}$/.test(tokenHash)) throw new Error("Invalid CLI credential");
  const credential = await ctx.db
    .query("cliCredentials")
    .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
    .first();
  if (!credential || credential.revokedAt !== undefined)
    throw new Error("CLI credential is invalid or revoked");
  return credential.ownerId;
};

export const reserveUpload = mutation({
  args: createArgs,
  handler: async (ctx, args) => reserveUploadForOwner(ctx, await requireOwnerId(ctx), args),
});
export const abandonUpload = mutation({
  args: abandonArgs,
  handler: async (ctx, args) => abandonUploadForOwner(ctx, await requireOwnerId(ctx), args),
});
export const create = mutation({
  args: createArgs,
  handler: async (ctx, args) => createForOwner(ctx, await requireOwnerId(ctx), args),
});
export const reserveUploadWithCliCredential = mutation({
  args: { ...createArgs, tokenHash: v.string() },
  handler: async (ctx, args) =>
    reserveUploadForOwner(ctx, await requireCliOwnerId(ctx, args.tokenHash), args),
});
export const abandonUploadWithCliCredential = mutation({
  args: { ...abandonArgs, tokenHash: v.string() },
  handler: async (ctx, args) =>
    abandonUploadForOwner(ctx, await requireCliOwnerId(ctx, args.tokenHash), args),
});
export const createWithCliCredential = mutation({
  args: { ...createArgs, tokenHash: v.string() },
  handler: async (ctx, args) =>
    createForOwner(ctx, await requireCliOwnerId(ctx, args.tokenHash), args),
});

export const getUploadReceiptForOwner = async (
  ctx: MutationCtx | QueryCtx,
  ownerId: string,
  input: { key: string; origin: string }
): Promise<UploadReceipt | null> => {
  validateReceiptLookup(input);
  const receipt = await findReceipt(ctx, ownerId, input);
  return receipt ? publicReceipt(receipt) : null;
};
export const uploadReceipt = query({
  args: receiptLookupArgs,
  handler: async (ctx, args) => getUploadReceiptForOwner(ctx, await requireOwnerId(ctx), args),
});
export const uploadReceiptWithCliCredential = query({
  args: { ...receiptLookupArgs, tokenHash: v.string() },
  handler: async (ctx, args) =>
    getUploadReceiptForOwner(ctx, await requireCliOwnerId(ctx, args.tokenHash), args),
});

export const requestDeletionForOwner = async (
  ctx: MutationCtx,
  ownerId: string,
  id: Id<"documents">
) => {
  const document = await ctx.db.get(id);

  if (!document || document.ownerId !== ownerId) {
    return "not_found" as const;
  }

  if (document.deletionRequestedAt !== undefined) {
    return "accepted" as const;
  }

  if (document.storageProvider !== undefined || document.storageKey !== undefined) {
    if (
      (document.storageProvider !== "uploadthing" &&
        !(
          document.storageProvider === "filesystem" &&
          isLocalDevelopment(process.env) &&
          isFilesystemKey(document.storageKey ?? "", ownerId)
        )) ||
      !document.storageKey ||
      document.storageId
    ) {
      throw new Error("External document storage metadata is incomplete");
    }
    const now = Date.now();
    await ctx.db.patch(id, { deletionRequestedAt: now });
    const jobId = await ctx.db.insert("deletionJobs", {
      documentId: id,
      storageKey: document.storageKey,
      storageProvider: document.storageProvider,
      nextAttemptAt: now,
      attempts: 0,
    });
    await ctx.scheduler.runAfter(0, deletionWorker, { jobId });
    return "accepted" as const;
  }

  if (!document.storageId || document.storageProvider || document.storageKey) {
    throw new Error("External documents require storage cleanup before metadata removal");
  }
  await ctx.storage.delete(document.storageId);
  await releaseAccountBytes(ctx, document.ownerId, document.sizeBytes);
  await ctx.db.delete(id);
  return "deleted" as const;
};

export const requestDeletion = mutation({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => requestDeletionForOwner(ctx, await requireOwnerId(ctx), args.id),
});

export const get = query({
  args: { id: v.id("documents") },
  handler: async (ctx, args) => {
    const ownerId = await requireOwnerId(ctx);
    const document = await ctx.db.get(args.id);

    if (!document || document.ownerId !== ownerId || document.deletionRequestedAt !== undefined) {
      return null;
    }

    return document;
  },
});

export const claimDeletion = internalMutation({
  args: { jobId: v.id("deletionJobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (!job || job.nextAttemptAt > now) return null;

    const attempts = job.attempts + 1;
    await ctx.db.patch(args.jobId, { attempts, nextAttemptAt: now + deletionLeaseMs });
    return {
      attempts,
      storageKey: job.storageKey,
      storageProvider: job.storageProvider ?? "uploadthing",
    };
  },
});

export const finishDeletion = internalMutation({
  args: { jobId: v.id("deletionJobs"), attempts: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.attempts !== args.attempts) return;
    const document = await ctx.db.get(job.documentId);
    if (document) {
      await releaseAccountBytes(ctx, document.ownerId, document.sizeBytes);
      await ctx.db.delete(job.documentId);
    }
    await ctx.db.delete(args.jobId);
  },
});

export const deferDeletion = internalMutation({
  args: { jobId: v.id("deletionJobs"), attempts: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.attempts !== args.attempts) return;
    const delay = deletionRetryDelay(job.attempts);
    await ctx.db.patch(args.jobId, { nextAttemptAt: Date.now() + delay });
    await ctx.scheduler.runAfter(delay, deletionWorker, { jobId: args.jobId });
  },
});

export const reconcileDeletions = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("deletionJobs")
      .withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", Date.now()))
      .take(100);
    for (const job of due) {
      await ctx.scheduler.runAfter(0, deletionWorker, { jobId: job._id });
    }
  },
});

export const getContent = internalQuery({
  args: {
    id: v.id("documents"),
    ownerId: v.string(),
  },
  handler: async (ctx, args) => {
    const document = await ctx.db.get(args.id);

    if (
      !document ||
      document.ownerId !== args.ownerId ||
      document.deletionRequestedAt !== undefined
    ) {
      return null;
    }

    if (!document.storageId) return null;

    return {
      storageId: document.storageId,
      contentType: document.contentType,
    };
  },
});

export const claimUploadCleanup = internalMutation({
  args: { reservationId: v.id("uploadReservations") },
  handler: async (ctx, { reservationId }) => {
    const reservation = await ctx.db.get(reservationId);
    if (!reservation || reservation.nextAttemptAt > Date.now()) return null;
    const document = await findStoredDocument(ctx, reservation.ownerId, reservation.storageKey);
    if (document) {
      await releaseAccountBytes(ctx, reservation.ownerId, reservation.sizeBytes);
      await ctx.db.delete(reservationId);
      return null;
    }
    // Cleanup admission and terminal receipt failure share the commit fence.
    if (reservation.receiptId)
      await ctx.db.patch(reservation.receiptId, {
        status: "failed",
        updatedAt: Date.now(),
      });
    if (!reservation.uploadConfirmed) {
      // A crashed process or interrupted HTTP request may still have an ingest
      // in progress. Keep its capacity charged for manual reconciliation.
      await ctx.db.patch(reservationId, {
        cleanupRequested: true,
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
      });
      return null;
    }
    const attempts = reservation.attempts + 1;
    await ctx.db.patch(reservationId, {
      cleanupRequested: true,
      attempts,
      nextAttemptAt: Date.now() + deletionLeaseMs,
    });
    return {
      attempts,
      storageKey: reservation.storageKey,
      storageProvider: reservation.storageProvider ?? "uploadthing",
    };
  },
});
export const finishUploadCleanup = internalMutation({
  args: { reservationId: v.id("uploadReservations"), attempts: v.number() },
  handler: async (ctx, { reservationId, attempts }) => {
    const reservation = await ctx.db.get(reservationId);
    if (
      reservation?.cleanupRequested &&
      reservation.uploadConfirmed &&
      attempts > 0 &&
      reservation.attempts === attempts
    ) {
      await releaseAccountBytes(ctx, reservation.ownerId, reservation.sizeBytes);
      await ctx.db.delete(reservationId);
    }
  },
});
export const deferUploadCleanup = internalMutation({
  args: { reservationId: v.id("uploadReservations"), attempts: v.number() },
  handler: async (ctx, { reservationId, attempts }) => {
    const reservation = await ctx.db.get(reservationId);
    if (!reservation || reservation.attempts !== attempts) return;
    const delay = deletionRetryDelay(attempts);
    await ctx.db.patch(reservationId, { nextAttemptAt: Date.now() + delay });
    await ctx.scheduler.runAfter(delay, uploadCleanupWorker, { reservationId });
  },
});
export const reconcileUploads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const due = await ctx.db
      .query("uploadReservations")
      .withIndex("by_nextAttemptAt", (q) => q.lte("nextAttemptAt", Date.now()))
      .take(100);
    for (const reservation of due)
      await ctx.scheduler.runAfter(0, uploadCleanupWorker, { reservationId: reservation._id });
  },
});
