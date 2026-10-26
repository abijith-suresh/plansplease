import { createHash, randomUUID } from "node:crypto";
import {
  cloudDocumentMaxBytes,
  cloudUploadFingerprint,
  isBundleHeader,
  validateDocumentId,
} from "@planview/core";
import { parseCloudBundle } from "@planview/core/cloud-bundle";
import {
  V1_RETENTION_MILLISECONDS,
  validateShareScope,
  type MetadataStore,
  type DocumentPublicationCoordinator,
  type SharePrepare,
  type SharePrepared,
  type ShareAttempt,
} from "@planview/storage";
import { Effect } from "effect";
import type { OperationGate } from "./operation-gate.js";

export function createDaemonSharing({
  metadataStore,
  publication,
  operationGate,
  origin,
}: {
  metadataStore: MetadataStore;
  publication: DocumentPublicationCoordinator;
  operationGate: OperationGate;
  origin: () => string;
}) {
  const inspect = (id: string, operation?: string) => {
    validateDocumentId(id);
    const local = metadataStore.getDocumentMetadataSnapshot(id);
    const attempts = operation
      ? {
          attempts: [metadataStore.getShareAttempt(operation)].filter(
            (row): row is ShareAttempt => row !== undefined
          ),
          hasMore: false,
        }
      : metadataStore.listShareAttempts(id);
    if (attempts.attempts.some((row) => row.id !== id))
      throw new Error("Share operation belongs to a different local snapshot.");
    return {
      id,
      ...(local
        ? {
            local: {
              id,
              generation: local.generation,
              size: local.size,
              expiresAt: local.lastAccessedAt + V1_RETENTION_MILLISECONDS,
              url: `${origin()}/${id}`,
            },
          }
        : {}),
      ...attempts,
    };
  };
  const prepare = (input: SharePrepare, requestSignal?: AbortSignal) =>
    operationGate(async (signal) => {
      const scope = validateShareScope(input);
      const snapshot = metadataStore.getDocumentMetadataSnapshot(scope.id);
      const previous = input.operation
        ? metadataStore.getShareAttempt(input.operation)
        : metadataStore.latestShareAttempt(scope);
      if (input.operation && !previous)
        throw new Error("Unknown local share operation. Do not upload again.");
      if (previous) {
        if (
          previous.id !== scope.id ||
          previous.origin !== scope.origin ||
          previous.accountId !== scope.accountId
        )
          throw new Error("Share operation belongs to another account, origin or local snapshot.");
        if (!input.newAttempt) {
          if (!input.operation && snapshot && snapshot.generation !== previous.generation)
            throw new Error(
              "Local generation changed. Select the prior operation explicitly for receipt lookup; do not bind it to this replacement."
            );
          return { attempt: previous, localUrl: `${origin()}/${scope.id}` };
        }
        if (previous.status !== "failed")
          throw new Error(
            "A new attempt requires proven terminal failure. Unknown operations must use receipt lookup."
          );
      } else if (input.newAttempt) throw new Error("There is no failed operation to replace.");
      if (!snapshot)
        throw new Error(
          "The local snapshot is missing; only an existing operation can be recovered."
        );
      const lease = await Effect.runPromise(
        publication.readPublishedDocumentLease(validateDocumentId(scope.id))
      );
      const abort = () => lease.stream.destroy(new Error("Snapshot capture cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      try {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of lease.stream) {
          signal.throwIfAborted();
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > 10 * 1024 * 1024) throw new Error("Snapshot exceeds the local 10 MiB bound.");
          chunks.push(bytes);
        }
        signal.throwIfAborted();
        const current = metadataStore.getDocumentMetadataSnapshot(scope.id);
        if (size !== snapshot.size || current?.generation !== snapshot.generation)
          throw new Error("Snapshot generation changed during capture.");
        const bytes = Buffer.concat(chunks);
        const contentSha256 = createHash("sha256").update(bytes).digest("hex");
        const contentType = isBundleHeader(bytes) ? "application/vnd.planview.bundle" : "text/html";
        let failureCode: "CLOUD_SIZE_LIMIT" | "CLOUD_FORMAT_REFUSED" | undefined;
        if (size > cloudDocumentMaxBytes) failureCode = "CLOUD_SIZE_LIMIT";
        else if (contentType !== "text/html") {
          try {
            parseCloudBundle(bytes);
          } catch {
            failureCode = "CLOUD_FORMAT_REFUSED";
          }
        }
        const title = `Snapshot ${scope.id}`;
        const attempt: ShareAttempt = {
          version: 1,
          ...scope,
          generation: snapshot.generation,
          key: randomUUID(),
          title,
          contentType,
          size,
          contentSha256,
          fingerprint: cloudUploadFingerprint(title, contentType, size, contentSha256),
          createdAt: Date.now(),
          status: failureCode ? "failed" : "unknown",
          ...(failureCode ? { failureCode } : {}),
        };
        // No caller can receive upload bytes until the operation key is durable.
        // A lost response leaves an unknown operation; never issue that key bytes twice.
        metadataStore.insertShareAttempt(attempt);
        return {
          attempt,
          localUrl: `${origin()}/${scope.id}`,
          ...(failureCode ? {} : { bytes: bytes.toString("base64") }),
        } satisfies SharePrepared;
      } finally {
        signal.removeEventListener("abort", abort);
        lease.stream.destroy();
        lease.release();
      }
    }, requestSignal);
  const record = (key: string, receipt: unknown, signal?: AbortSignal) =>
    operationGate(async () => metadataStore.recordShareReceipt(key, receipt), signal);
  return { inspect, prepare, record };
}
