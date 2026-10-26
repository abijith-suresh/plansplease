import { ConvexError } from "convex/values";

import type { DocumentStorageUpload, StoredDocument } from "./document-storage.ts";

import {
  reportDocumentUploadCompensationFailure,
  type DocumentUploadCompensationReporter,
} from "./document-upload-compensation.ts";

import type { UploadOperation } from "../../convex/documentProof.ts";
export type { UploadReservation } from "../../convex/uploadReceipt.ts";

export type DocumentUploadMetadata = {
  operation?: UploadOperation;
  title: string;
  storageProvider: StoredDocument["storageProvider"];
  storageKey: string;
  contentType: "text/html" | "application/vnd.planview.bundle";
  sizeBytes: number;
};

export async function uploadReservedDocument(input: {
  metadata: DocumentUploadMetadata;
  file: File;
  objectId: string;
  reserve(): Promise<{ id: string | null; uploadDeadlineAt: number }>;
  upload(options: DocumentStorageUpload): Promise<StoredDocument>;
  commit(): Promise<string>;
  abandon(uploadConfirmed: boolean): Promise<string | null>;
  reportCompensationFailure?: DocumentUploadCompensationReporter;
}) {
  // Admission must succeed before the provider receives any bytes. The same
  // reservation is exchanged for metadata in a single Convex transaction.
  const reservation = await input.reserve();
  if (reservation.id) return reservation.id;
  let uploadConfirmed = false;
  try {
    const stored = await input.upload({
      file: input.file,
      objectId: input.objectId,
      deadlineAt: reservation.uploadDeadlineAt,
    });
    if (
      stored.storageProvider !== input.metadata.storageProvider ||
      stored.storageKey !== input.metadata.storageKey
    ) {
      // A mismatched locator cannot prove that the reserved object is safe to delete.
      throw new Error("The stored document does not match its upload reservation.");
    }
    uploadConfirmed = true;
    return await input.commit();
  } catch (metadataCause) {
    try {
      // Do not delete directly after an ambiguous commit response. The backend
      // returns a committed document or fences the reservation for cleanup.
      const committedId = await input.abandon(uploadConfirmed);
      if (committedId) return committedId;
    } catch (cleanupCause) {
      await reportDocumentUploadCompensationFailure(input.reportCompensationFailure, {
        objectKey: input.metadata.storageKey,
        metadataCause,
        cleanupCause,
      });
    }
    throw metadataCause;
  }
}

export function storageQuotaErrorResponse(error: unknown) {
  if (
    !(error instanceof ConvexError) ||
    !error.data ||
    typeof error.data !== "object" ||
    Array.isArray(error.data) ||
    error.data.code !== "STORAGE_QUOTA_EXCEEDED"
  )
    return null;
  return Response.json({ ...error.data, error: error.data.message }, { status: 409 });
}
