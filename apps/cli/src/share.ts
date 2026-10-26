import { createHash } from "node:crypto";
import {
  matchCloudUploadReceipt,
  parseCloudUploadIdentity,
  parseCloudUploadReceipt,
  uploadProtocolHeader,
  validateDocumentId,
  V1_STORAGE_QUOTA_BYTES,
  type CloudUploadReceipt,
} from "@planview/core";
import type {
  LocalApplication,
  ShareAttempt,
  ShareInspection,
  SharePrepared,
} from "@planview/local";
import { Effect } from "effect";
import { requireCloudCredentials, type Credentials } from "./cloud.js";

const MAX_RESPONSE_BYTES = 16 * 1024;
async function cloudRequest(credentials: Credentials, init: RequestInit, timeoutMs: number) {
  const response = await fetch(`${credentials.cloudUrl}/api/documents/upload`, {
    ...init,
    headers: {
      ...init.headers,
      Accept: "application/json",
      Authorization: `Bearer ${credentials.token}`,
      [uploadProtocolHeader]: "1",
    },
    redirect: "error",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Cloud response missing.");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Cloud response exceeded its bound.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return {
    status: response.status,
    body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
  };
}
const receiptFrom = (
  response: Awaited<ReturnType<typeof cloudRequest>>,
  attempt: ShareAttempt
): CloudUploadReceipt => {
  const receipt = matchCloudUploadReceipt(
    parseCloudUploadReceipt(response.body["receipt"]),
    attempt
  );
  const outcome = receipt.status === "pending" ? "unknown" : receipt.status;
  const statuses =
    receipt.status === "committed" ? [200, 201] : receipt.status === "pending" ? [202] : [409];
  if (
    !statuses.includes(response.status) ||
    response.body["outcome"] !== outcome ||
    (receipt.status === "committed" && response.body["id"] !== receipt.documentId)
  )
    throw new Error("Cloud receipt response disagrees with its outcome.");
  return receipt;
};
export type ShareResult = {
  local: {
    id: string;
    status: "available" | "missing";
    url?: string;
    generation?: string;
    contentSha256?: string;
    size?: number;
    expiresAt?: number;
    retentionDays: 30;
    quotaBytes: number;
  };
  cloud: {
    status: "committed" | "failed" | "unknown";
    origin?: string;
    accountId?: string;
    operationKey?: string;
    fingerprint?: string;
    documentId?: string;
    url?: string;
    receipt?: CloudUploadReceipt;
    code?: string;
  };
  bookkeeping: "recorded" | "unknown" | "not_started";
  recovery: string;
};
export async function shareSnapshot(
  application: LocalApplication,
  id: string,
  profile?: string,
  options: { newAttempt?: boolean; operation?: string; timeoutMs?: number } = {}
): Promise<ShareResult> {
  validateDocumentId(id);
  const inspection = await Effect.runPromise(application.shareInspect(id, options.operation));
  if (!inspection.local && inspection.attempts.length === 0)
    throw new Error("No local snapshot or share operation exists for this id.");
  const local = localResult(inspection);
  let credentials: Credentials;
  let identity: ReturnType<typeof parseCloudUploadIdentity>;
  try {
    credentials = await requireCloudCredentials(profile);
    const answer = await cloudRequest(credentials, { method: "GET" }, options.timeoutMs ?? 10_000);
    if (answer.status !== 200) throw new Error("Cloud identity unavailable.");
    identity = parseCloudUploadIdentity(answer.body, credentials.cloudUrl);
  } catch {
    return {
      local,
      cloud: { status: "failed", code: "CLOUD_PREFLIGHT_REFUSED" },
      bookkeeping: "not_started",
      recovery:
        "Cloud admission was not started. Check configured sign-in and receipt-protocol support. Existing attempts are unchanged; inspect them before any new attempt.",
    };
  }
  let prepared: SharePrepared;
  try {
    prepared = await Effect.runPromise(
      application.sharePrepare({
        id,
        origin: identity.origin,
        accountId: identity.accountId,
        ...(options.newAttempt ? { newAttempt: true } : {}),
        ...(options.operation ? { operation: options.operation } : {}),
      })
    );
    if (
      prepared.attempt.id !== id ||
      prepared.attempt.origin !== identity.origin ||
      prepared.attempt.accountId !== identity.accountId ||
      (options.operation !== undefined &&
        (prepared.attempt.key !== options.operation || prepared.bytes !== undefined))
    )
      throw new Error("Prepared share identity or recovery lease mismatch.");
  } catch {
    return {
      local,
      cloud: {
        status: "unknown",
        origin: identity.origin,
        accountId: identity.accountId,
        code: "LOCAL_PREPARATION_UNCONFIRMED",
      },
      bookkeeping: "unknown",
      recovery:
        "No upload was sent by this invocation. Inspect this id's durable attempts, then run share again for receipt lookup. A lost prepare response may already own a key; never replace an unknown key.",
    };
  }
  const { attempt } = prepared;
  const sameGeneration = inspection.local?.generation === attempt.generation;
  const { url: observedUrl, expiresAt: observedExpiry, ...localObservation } = local;
  const result: ShareResult = {
    local: {
      ...localObservation,
      status: sameGeneration ? "available" : "missing",
      ...(sameGeneration && observedUrl ? { url: observedUrl } : {}),
      ...(sameGeneration && observedExpiry !== undefined ? { expiresAt: observedExpiry } : {}),
      generation: attempt.generation,
      size: attempt.size,
      contentSha256: attempt.contentSha256,
    },
    cloud: {
      status: attempt.status,
      origin: attempt.origin,
      accountId: attempt.accountId,
      operationKey: attempt.key,
      fingerprint: attempt.fingerprint,
      ...(attempt.failureCode ? { code: attempt.failureCode } : {}),
      ...(attempt.receipt ? { receipt: attempt.receipt } : {}),
    },
    bookkeeping: "recorded",
    recovery: "none",
  };
  const finish = (receipt: CloudUploadReceipt) => {
    result.cloud.status = receipt.status === "pending" ? "unknown" : receipt.status;
    result.cloud.receipt = receipt;
    if (receipt.documentId) {
      result.cloud.documentId = receipt.documentId;
      result.cloud.url = `${attempt.origin}/api/documents/${encodeURIComponent(receipt.documentId)}`;
    }
  };
  if (attempt.status !== "unknown") {
    if (attempt.receipt) finish(attempt.receipt);
    result.recovery =
      attempt.status === "failed"
        ? "Terminal failure. A deliberate new attempt may use --new-attempt; local data is independent."
        : "none";
    return result;
  }
  try {
    let response: Awaited<ReturnType<typeof cloudRequest>>;
    if (prepared.bytes !== undefined) {
      const bytes = Buffer.from(prepared.bytes, "base64");
      if (
        bytes.length !== attempt.size ||
        createHash("sha256").update(bytes).digest("hex") !== attempt.contentSha256
      )
        throw new Error("Snapshot capture integrity failure.");
      const form = new FormData();
      form.set("title", attempt.title);
      form.set(
        "file",
        new File(
          [bytes],
          attempt.contentType === "text/html" ? "snapshot.html" : "artifact.planview",
          { type: attempt.contentType }
        )
      );
      response = await cloudRequest(
        credentials,
        { method: "POST", headers: { "Idempotency-Key": attempt.key }, body: form },
        options.timeoutMs ?? 5 * 60_000
      );
    } else {
      response = await cloudRequest(
        credentials,
        { method: "GET", headers: { "Idempotency-Key": attempt.key } },
        options.timeoutMs ?? 10_000
      );
    }
    const receipt = receiptFrom(response, attempt);
    finish(receipt);
    try {
      await Effect.runPromise(application.shareRecord(attempt.key, receipt));
    } catch {
      result.bookkeeping = "unknown";
    }
  } catch {
    result.cloud.status = "unknown";
    result.cloud.code = "CLOUD_OUTCOME_UNCONFIRMED";
  }
  if (result.cloud.status === "unknown" || result.bookkeeping === "unknown")
    result.recovery = `Run share ${id} --operation ${attempt.key} with the same account and origin for authenticated receipt lookup only. not_found is not proof of failure; do not resend bytes or replace this key.`;
  else if (result.cloud.status === "failed")
    result.recovery =
      "Terminal document failure. A deliberate new attempt may use --new-attempt. Provider cleanup may still be pending. Local data is independent.";
  return result;
}
function localResult(inspection: ShareInspection): ShareResult["local"] {
  return {
    id: inspection.id,
    status: inspection.local ? "available" : "missing",
    ...(inspection.local ?? {}),
    retentionDays: 30,
    quotaBytes: V1_STORAGE_QUOTA_BYTES,
  };
}
