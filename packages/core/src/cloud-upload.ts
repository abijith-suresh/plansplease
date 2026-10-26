import { createHash } from "node:crypto";
import { cloudDocumentMaxBytes } from "./cloud-policy.js";

export type CloudUploadOperation = Readonly<{
  key: string;
  origin: string;
  fingerprint: string;
  contentSha256: string;
}>;
export type CloudUploadReceipt = CloudUploadOperation &
  Readonly<{
    version: 1;
    accountId: string;
    status: "pending" | "committed" | "failed";
    documentId?: string;
    failureCode?: string;
  }>;
export const uploadProtocolHeader = "Planview-Upload-Protocol";
export const cloudUploadFingerprint = (
  title: string,
  contentType: string,
  size: number,
  hash: string
) =>
  createHash("sha256")
    .update(JSON.stringify(["planview-upload-v1", title, contentType, size, hash]))
    .digest("hex");
export function cloudOrigin(value: string) {
  const url = new URL(value);
  if (
    url.origin !== value ||
    value.length > 512 ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  )
    throw new Error("Invalid cloud origin.");
  return value;
}
export const cloudAccount = (value: unknown): string => {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error("Invalid cloud account identity.");
  return value;
};
export const uploadOperationKey = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value))
    throw new Error("Invalid upload operation key.");
  return value;
};
export const sha256String = (value: unknown): string => {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("Invalid SHA-256 fingerprint.");
  return value;
};
export function parseCloudUploadReceipt(value: unknown): CloudUploadReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Missing cloud upload receipt.");
  const row = value as Record<string, unknown>;
  if (
    row["version"] !== 1 ||
    typeof row["origin"] !== "string" ||
    !["pending", "committed", "failed"].includes(String(row["status"]))
  )
    throw new Error("Invalid cloud receipt protocol.");
  const status = row["status"] as CloudUploadReceipt["status"];
  const documentId = row["documentId"];
  const failureCode = row["failureCode"];
  if (
    (status === "committed" &&
      (typeof documentId !== "string" || !documentId || documentId.length > 256)) ||
    (status !== "committed" && documentId !== undefined) ||
    (failureCode !== undefined && (typeof failureCode !== "string" || failureCode.length > 100))
  )
    throw new Error("Invalid cloud receipt outcome.");
  return {
    version: 1,
    accountId: cloudAccount(row["accountId"]),
    origin: cloudOrigin(row["origin"]),
    key: uploadOperationKey(row["key"]),
    fingerprint: sha256String(row["fingerprint"]),
    contentSha256: sha256String(row["contentSha256"]),
    status,
    ...(typeof documentId === "string" ? { documentId } : {}),
    ...(typeof failureCode === "string" ? { failureCode } : {}),
  };
}
export function matchCloudUploadReceipt(
  receipt: CloudUploadReceipt,
  expected: CloudUploadOperation & { accountId: string }
) {
  if (
    ["accountId", "origin", "key", "fingerprint", "contentSha256"].some(
      (key) =>
        receipt[key as keyof CloudUploadOperation | "accountId"] !==
        expected[key as keyof CloudUploadOperation | "accountId"]
    )
  )
    throw new Error(
      "Cloud receipt account, origin, operation or content conflict. Keep this operation key for investigation."
    );
  return receipt;
}
export function parseCloudUploadIdentity(value: unknown, origin: string) {
  if (!value || typeof value !== "object") throw new Error("Cloud upload protocol is unsupported.");
  const row = value as Record<string, unknown>;
  if (
    row["version"] !== 1 ||
    row["origin"] !== cloudOrigin(origin) ||
    row["maxBytes"] !== cloudDocumentMaxBytes ||
    row["receipts"] !== true
  )
    throw new Error("Cloud upload protocol is unsupported or origin changed.");
  return {
    version: 1 as const,
    origin,
    accountId: cloudAccount(row["accountId"]),
    maxBytes: cloudDocumentMaxBytes,
  };
}
