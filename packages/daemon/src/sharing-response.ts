import { retentionFromPayload } from "./snapshot-response.js";
import { validateDocumentId } from "@planview/core";
import {
  parseShareAttempt,
  validateSnapshotSelection,
  SHARE_INSPECTION_LIMIT,
  type SharePrepared,
  type ShareInspection,
} from "@planview/storage";
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid daemon share response.");
  return value as Record<string, unknown>;
};
const localUrl = (value: unknown, id: string) => {
  if (typeof value !== "string") throw new Error("Invalid local share URL.");
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== `/${id}`
  )
    throw new Error("Invalid local share URL.");
  return value;
};
export function parseSharePrepared(value: unknown): SharePrepared {
  const row = record(value);
  const attempt = parseShareAttempt(row["attempt"]);
  const bytes = row["bytes"];
  if (
    bytes !== undefined &&
    (typeof bytes !== "string" ||
      bytes.length > 12 * 1024 * 1024 ||
      bytes.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(bytes) ||
      attempt.status !== "unknown")
  )
    throw new Error("Invalid snapshot upload bytes.");
  return {
    attempt,
    localUrl: localUrl(row["localUrl"], attempt.id),
    ...(typeof bytes === "string" ? { bytes } : {}),
  };
}
export function parseShareInspection(value: unknown): ShareInspection {
  const row = record(value);
  const id = validateDocumentId(row["id"]);
  if (
    !Array.isArray(row["attempts"]) ||
    row["attempts"].length > SHARE_INSPECTION_LIMIT ||
    typeof row["hasMore"] !== "boolean"
  )
    throw new Error("Invalid share inspection page.");
  const attempts = row["attempts"].map(parseShareAttempt);
  if (attempts.some((attempt) => attempt.id !== id))
    throw new Error("Share inspection identity mismatch.");
  const local = row["local"] === undefined ? undefined : record(row["local"]);
  if (local && (!Number.isSafeInteger(local["size"]) || Number(local["size"]) < 0))
    throw new Error("Invalid local snapshot metadata.");
  return {
    id,
    attempts,
    hasMore: row["hasMore"],
    ...(local
      ? {
          local: {
            ...validateSnapshotSelection({ id, generation: String(local["generation"]) }),
            size: Number(local["size"]),
            ...retentionFromPayload(local),
            url: localUrl(local["url"], id),
          },
        }
      : {}),
  };
}
