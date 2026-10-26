import { createHash } from "node:crypto";
import { ConvexError } from "convex/values";
import type { UploadOperation } from "../../convex/documentProof.ts";
import type { UploadReceipt } from "../../convex/uploadReceipt.ts";
import {
  uploadReservedDocument,
  type DocumentUploadMetadata,
  type UploadReservation,
} from "./reserved-document-upload.ts";
import type { DocumentUploadCompensationReporter } from "./document-upload-compensation.ts";
import type { DocumentStorageUpload, StoredDocument } from "./document-storage.ts";

export function fingerprintUpload(input: {
  key: string;
  origin: string;
  title: string;
  contentType: string;
  bytes: Uint8Array;
}): UploadOperation {
  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "planview-upload-v1",
        input.title,
        input.contentType,
        input.bytes.byteLength,
        contentSha256,
      ])
    )
    .digest("hex");
  return { key: input.key, origin: input.origin, fingerprint, contentSha256 };
}

export function receiptResponse(receipt: UploadReceipt, replayed = true) {
  return Response.json(
    {
      ...(receipt.documentId ? { id: receipt.documentId } : {}),
      outcome: receipt.status === "pending" ? "unknown" : receipt.status,
      receipt,
      replayed,
    },
    {
      status:
        receipt.status === "committed"
          ? replayed
            ? 200
            : 201
          : receipt.status === "failed"
            ? 409
            : 202,
      headers: { "Cache-Control": "private, no-store" },
    }
  );
}

function conflictResponse() {
  return Response.json(
    {
      code: "UPLOAD_OPERATION_CONFLICT",
      outcome: "rejected",
      error: "This operation key is already bound to different content or metadata.",
    },
    { status: 409, headers: { "Cache-Control": "private, no-store" } }
  );
}
function checkedReceiptResponse(
  receipt: UploadReceipt,
  accountId: string,
  operation: UploadOperation,
  replayed = true
) {
  if (
    receipt.accountId !== accountId ||
    receipt.origin !== operation.origin ||
    receipt.key !== operation.key
  ) {
    throw new Error("Upload receipt identity mismatch");
  }
  if (
    receipt.fingerprint !== operation.fingerprint ||
    receipt.contentSha256 !== operation.contentSha256
  ) {
    return conflictResponse();
  }
  return receiptResponse(receipt, replayed);
}

export async function uploadWithReceipt(input: {
  metadata: DocumentUploadMetadata & { operation: UploadOperation };
  accountId: string;
  file: File;
  objectId: string;
  reserve(): Promise<UploadReservation>;
  upload(options: DocumentStorageUpload): Promise<StoredDocument>;
  commit(): Promise<string>;
  abandon(uploadConfirmed: boolean): Promise<string | null>;
  getReceipt(): Promise<UploadReceipt | null>;
  reportCompensationFailure?: DocumentUploadCompensationReporter;
}) {
  try {
    const reservation = await input.reserve();
    if (!reservation.receipt) throw new Error("Upload receipt was not returned");
    const reservedResponse = checkedReceiptResponse(
      reservation.receipt,
      input.accountId,
      input.metadata.operation
    );
    if (!reservation.admitted || reservedResponse.status === 409) return reservedResponse;
    const id = await uploadReservedDocument({ ...input, reserve: async () => reservation });
    // The commit mutation durably records the document and receipt together.
    return receiptResponse({ ...reservation.receipt, status: "committed", documentId: id }, false);
  } catch (error) {
    if (
      error instanceof ConvexError &&
      typeof error.data === "object" &&
      error.data !== null &&
      !Array.isArray(error.data) &&
      ["UPLOAD_OPERATION_CONFLICT", "STORAGE_QUOTA_EXCEEDED"].includes(String(error.data.code))
    ) {
      return Response.json(
        { ...error.data, error: error.data.message, outcome: "rejected" },
        { status: 409, headers: { "Cache-Control": "private, no-store" } }
      );
    }
    // A lost reserve/commit/fence response cannot prove failure. Reading the
    // durable receipt may settle it; do not replay bytes or infer from a timeout.
    try {
      const receipt = await input.getReceipt();
      if (receipt)
        return checkedReceiptResponse(receipt, input.accountId, input.metadata.operation);
    } catch {
      /* Backend unavailable: preserve uncertainty. */
    }
    return Response.json(
      {
        outcome: "unknown",
        code: "UPLOAD_OUTCOME_UNKNOWN",
        operation: { version: 1, accountId: input.accountId, ...input.metadata.operation },
        error:
          "The upload outcome could not be confirmed. Query this operation before taking further action.",
      },
      { status: 503, headers: { "Cache-Control": "private, no-store" } }
    );
  }
}
