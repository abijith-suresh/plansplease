import { validateDocumentId } from "@planview/core";
import {
  validateSnapshotSelection,
  type SnapshotDeleteResult,
  type SnapshotRetention,
  type SnapshotPinResult,
  type SnapshotInventory,
  type SnapshotUsage,
} from "@planview/storage";

const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid daemon snapshot response.");
  return value as Record<string, unknown>;
};
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid daemon snapshot count.");
  return value;
};
const selection = (value: unknown) => {
  const row = record(value);
  if (typeof row["id"] !== "string" || typeof row["generation"] !== "string")
    throw new Error("Invalid daemon snapshot selection.");
  return validateSnapshotSelection({ id: row["id"], generation: row["generation"] });
};
export const retentionFromPayload = (value: unknown): SnapshotRetention => {
  const row = record(value);
  const pinned = row["pinned"];
  const unpinnedExpiresAt = integer(row["unpinnedExpiresAt"]);
  if (typeof pinned !== "boolean" || row["expiresAt"] !== (pinned ? null : unpinnedExpiresAt))
    throw new Error("Invalid daemon retention state.");
  return { pinned, unpinnedExpiresAt, expiresAt: pinned ? null : unpinnedExpiresAt };
};
export const pinFromPayload = (value: unknown): SnapshotPinResult => {
  const row = record(value);
  const status = row["status"];
  if (
    typeof status !== "string" ||
    !["updated", "stale", "not_found", "unavailable"].includes(status)
  )
    throw new Error("Invalid daemon pin response.");
  return {
    ...selection(row),
    status: status as SnapshotPinResult["status"],
    ...(status === "updated" ? { retention: retentionFromPayload(row["retention"]) } : {}),
  };
};
export const inventoryFromPayload = (value: unknown): SnapshotInventory => {
  const payload = record(value);
  if (!Array.isArray(payload["snapshots"]) || payload["snapshots"].length > 100)
    throw new Error("Invalid daemon inventory page.");
  return {
    snapshots: payload["snapshots"].map((value) => {
      const row = record(value);
      const createdAt = integer(row["createdAt"]);
      const lastAccessedAt = integer(row["lastAccessedAt"]);
      const retention = retentionFromPayload(row);
      if (lastAccessedAt < createdAt || retention.unpinnedExpiresAt < lastAccessedAt)
        throw new Error("Invalid daemon snapshot times.");
      return {
        ...selection(row),
        createdAt,
        lastAccessedAt,
        ...retention,
        size: integer(row["size"]),
      };
    }),
    ...(payload["nextAfter"] === undefined
      ? {}
      : { nextAfter: validateDocumentId(payload["nextAfter"]) }),
  };
};
export const usageFromPayload = (value: unknown): SnapshotUsage => {
  const row = record(value);
  return {
    pinnedBytes: integer(row["pinnedBytes"]),
    pinnedCount: integer(row["pinnedCount"]),
    bytes: integer(row["bytes"]),
    documentBytes: integer(row["documentBytes"]),
    metadataBytes: integer(row["metadataBytes"]),
    documentCount: integer(row["documentCount"]),
    quotaBytes: integer(row["quotaBytes"]),
    retentionMilliseconds: integer(row["retentionMilliseconds"]),
  };
};
export const deletionFromPayload = (value: unknown): SnapshotDeleteResult => {
  const row = record(value);
  const { status, removedMetadata, removedFile, fileState, recovery, message } = row;
  if (
    (status !== "deleted" &&
      status !== "not_found" &&
      status !== "stale" &&
      status !== "retained" &&
      status !== "partial") ||
    typeof removedMetadata !== "boolean" ||
    typeof removedFile !== "boolean" ||
    (fileState !== "absent" && fileState !== "retained" && fileState !== "unknown") ||
    (recovery !== "none" &&
      recovery !== "retry_selection" &&
      recovery !== "clean" &&
      recovery !== "inspect") ||
    (message !== undefined && typeof message !== "string")
  )
    throw new Error("Invalid daemon deletion response.");
  return {
    ...selection(row),
    status,
    removedMetadata,
    removedFile,
    fileState,
    recovery,
    ...(message === undefined ? {} : { message }),
  };
};
