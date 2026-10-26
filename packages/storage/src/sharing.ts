import {
  cloudAccount,
  cloudOrigin,
  cloudUploadFingerprint,
  matchCloudUploadReceipt,
  parseCloudUploadReceipt,
  sha256String,
  uploadOperationKey,
  validateDocumentId,
  type CloudUploadReceipt,
} from "@planview/core";
import { type SnapshotRetention, validateSnapshotSelection } from "./management.js";

export type ShareAttempt = Readonly<{
  version: 1;
  id: string;
  generation: string;
  key: string;
  origin: string;
  accountId: string;
  title: string;
  contentType: "text/html" | "application/vnd.planview.bundle";
  size: number;
  contentSha256: string;
  fingerprint: string;
  createdAt: number;
  status: "unknown" | "committed" | "failed";
  failureCode?: string;
  receipt?: CloudUploadReceipt;
}>;
export type ShareScope = Readonly<{ id: string; origin: string; accountId: string }>;
export type SharePrepare = ShareScope & Readonly<{ newAttempt?: boolean; operation?: string }>;
export type ShareInspection = Readonly<{
  id: string;
  local?: { id: string; generation: string; size: number; url: string } & SnapshotRetention;
  attempts: readonly ShareAttempt[];
  hasMore: boolean;
}>;
export type SharePrepared = Readonly<{ attempt: ShareAttempt; bytes?: string; localUrl: string }>;
export const MAX_SHARE_ATTEMPTS = 10_000;
export const SHARE_INSPECTION_LIMIT = 20;
export function validateShareScope(input: ShareScope): ShareScope {
  return {
    id: validateDocumentId(input.id),
    origin: cloudOrigin(input.origin),
    accountId: cloudAccount(input.accountId),
  };
}
export function parseShareAttempt(value: unknown): ShareAttempt {
  if (!value || typeof value !== "object") throw new Error("Invalid local share attempt.");
  const row = value as ShareAttempt;
  validateSnapshotSelection(row);
  validateShareScope(row);
  uploadOperationKey(row.key);
  sha256String(row.contentSha256);
  sha256String(row.fingerprint);
  if (
    row.version !== 1 ||
    !Number.isSafeInteger(row.createdAt) ||
    row.createdAt < 0 ||
    !Number.isSafeInteger(row.size) ||
    row.size < 0 ||
    row.size > 10 * 1024 * 1024 ||
    typeof row.title !== "string" ||
    !row.title ||
    row.title.length > 200 ||
    !["text/html", "application/vnd.planview.bundle"].includes(row.contentType) ||
    !["unknown", "committed", "failed"].includes(row.status) ||
    row.fingerprint !==
      cloudUploadFingerprint(row.title, row.contentType, row.size, row.contentSha256)
  )
    throw new Error("Invalid local share attempt binding.");
  const receipt =
    row.receipt === undefined
      ? undefined
      : matchCloudUploadReceipt(parseCloudUploadReceipt(row.receipt), row);
  if (receipt && (receipt.status === "pending" ? "unknown" : receipt.status) !== row.status)
    throw new Error("Local and cloud receipt outcomes disagree.");
  const localRefusal =
    row.status === "failed" &&
    !receipt &&
    (row.failureCode === "CLOUD_SIZE_LIMIT" || row.failureCode === "CLOUD_FORMAT_REFUSED");
  if (
    (row.status !== "unknown" && !receipt && !localRefusal) ||
    (row.failureCode !== undefined && !localRefusal)
  )
    throw new Error("A terminal share requires a verified receipt or local preflight refusal.");
  return {
    version: 1,
    ...validateShareScope(row),
    generation: row.generation,
    key: row.key,
    title: row.title,
    contentType: row.contentType,
    size: row.size,
    contentSha256: row.contentSha256,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
    status: row.status,
    ...(row.failureCode === "CLOUD_SIZE_LIMIT" || row.failureCode === "CLOUD_FORMAT_REFUSED"
      ? { failureCode: row.failureCode }
      : {}),
    ...(receipt ? { receipt } : {}),
  };
}
