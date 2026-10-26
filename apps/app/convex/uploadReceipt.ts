import { ConvexError, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx, QueryCtx } from "./_generated/server.js";
import type { UploadOperation } from "./documentProof.ts";

export const operationValidator = v.object({
  key: v.string(),
  origin: v.string(),
  fingerprint: v.string(),
  contentSha256: v.string(),
});
export const receiptLookupArgs = { key: v.string(), origin: v.string() };
export type UploadReceipt = {
  version: 1;
  accountId: string;
  origin: string;
  key: string;
  fingerprint: string;
  contentSha256: string;
  status: "pending" | "committed" | "failed";
  documentId?: string;
  failureCode?: string;
};

export function validateReceiptLookup(input: { key: string; origin: string }) {
  let origin: URL;
  try {
    origin = new URL(input.origin);
  } catch {
    throw new Error("Invalid upload origin");
  }
  if (
    origin.origin !== input.origin ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      )) ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(input.key)
  ) {
    throw new Error("Invalid upload operation key or origin");
  }
}
export function validateOperation(operation: UploadOperation) {
  validateReceiptLookup(operation);
  if (
    !/^[a-f0-9]{64}$/.test(operation.fingerprint) ||
    !/^[a-f0-9]{64}$/.test(operation.contentSha256)
  )
    throw new Error("Invalid upload fingerprint");
}

export const findReceipt = (
  ctx: Pick<MutationCtx | QueryCtx, "db">,
  ownerId: string,
  input: { key: string; origin: string }
) =>
  ctx.db
    .query("uploadReceipts")
    .withIndex("by_owner_origin_key", (q) =>
      q.eq("ownerId", ownerId).eq("origin", input.origin).eq("key", input.key)
    )
    .unique();

export function publicReceipt(row: Doc<"uploadReceipts">): UploadReceipt {
  return {
    version: 1,
    accountId: row.ownerId,
    origin: row.origin,
    key: row.key,
    fingerprint: row.fingerprint,
    contentSha256: row.contentSha256,
    status: row.status,
    ...(row.documentId ? { documentId: row.documentId } : {}),
    ...(row.failureCode ? { failureCode: row.failureCode } : {}),
  };
}
export function assertReceiptMatches(row: Doc<"uploadReceipts">, operation: UploadOperation) {
  if (row.fingerprint !== operation.fingerprint || row.contentSha256 !== operation.contentSha256) {
    throw new ConvexError({
      code: "UPLOAD_OPERATION_CONFLICT",
      message: "This operation key is already bound to different content or metadata.",
    });
  }
}

export type UploadReservation = {
  id: string | null;
  uploadDeadlineAt: number;
  receipt?: UploadReceipt;
  admitted?: boolean;
};
