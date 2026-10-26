---
title: Cloud upload operations
description: Optional account-scoped idempotency and durable upload receipts.
---

This protocol is implemented in source and tested with local fixtures. Hosted
use requires compatible app and Convex releases. No deployment is implied.
`plansplease upload PATH` and hosted MCP keep their existing behavior. `share LOCAL_ID` explicitly opts in for existing daemon-owned snapshots. There is
no automatic retry or background synchronization.

## Opt in to one operation

Send the existing multipart `POST /api/documents/upload` with an
`Idempotency-Key` header. Use a new random key of 16 to 128 ASCII letters,
digits, underscores or hyphens for each deliberate operation. Authenticate with
the existing browser session or upload-only CLI credential. The key is an
identifier, never an authentication credential. Do not send credentials in URLs.

The server binds the key to the authenticated account and its configured
`SITE_URL` origin. Request origin must match that configured origin; the caller
cannot choose another receipt namespace through a header or form field. Another
account or app origin has an independent namespace. Receipts never authorize
reading, listing, or deleting cloud documents.

After the existing HTML/bundle, title and 8 MiB checks, the server hashes the
exact file bytes with SHA-256. The v1 fingerprint is SHA-256 of UTF-8 JSON:

```text
["planview-upload-v1", trimmedTitle, contentType, byteLength, contentSha256]
```

The hash uses lowercase hexadecimal. Content type is `text/html` or
`application/vnd.planview.bundle`. Bundle bytes include the encoded manifest.
Filenames and multipart encoding are excluded; changing either does not change
an otherwise identical operation. Changing bytes, title or content type does.
The server computes both hashes and signs the account, operation, fingerprint
and provider locator with its existing short-lived mutation proof.

## Outcomes and recovery

Quota admission, the pending receipt, reservation, and cleanup scheduling share
one Convex transaction. The account/origin/key index is read in that transaction;
concurrent requests contend on the same indexed range. Only the first admitted
request receives permission to send provider bytes. Repeated requests return the
receipt, even while the first request is active. They never upload again or take
over an expired lease. Different content or metadata returns
`409 UPLOAD_OPERATION_CONFLICT` without changing the original receipt.

| HTTP status | Outcome | Meaning |
| --- | --- | --- |
| 201 | `committed` | First request confirmed a durable document and receipt. |
| 200 | `committed` | A repeated request or lookup recovered the recorded document ID. |
| 202 | `unknown` | Receipt is `pending`. Work may be active or interrupted; no final result is proven. |
| 409 | `failed` | A durable receipt proves this operation cannot create a document. |
| 409 | `rejected` | The key conflicts with a previously bound fingerprint. |
| 503 | `unknown` | The backend could not confirm an outcome. An `operation` descriptor is returned, not a fabricated receipt. |

A recorded response includes `receipt` and `replayed`, plus `id` for a committed
operation. A receipt contains `version: 1`, `accountId`, `origin`, `key`,
`fingerprint`, `contentSha256`, `status`, and an optional `documentId` or
`failureCode`. A quota refusal records a terminal failed receipt with
`failureCode: "STORAGE_QUOTA_EXCEEDED"`; increasing quota does not revive that
key. A deliberate new attempt needs a new key after the original outcome is
understood. Prevalidation and authentication errors do not admit an operation.

To recover a lost final response without resending bytes, send authenticated
`GET /api/documents/upload` with the same `Idempotency-Key` header to the same
origin. The GET supports browser sessions and upload-only CLI credentials only
for their owning account. Revoked credentials fail authentication. It uses the
same outcome statuses, with 200 for a committed receipt. A 404 `not_found` means
no receipt existed at that query's read point. It does not prove that a
concurrent admission cannot still commit. Transport errors and backend failures
are not evidence of document failure. A GET failure returns the existing error
response and cannot establish an operation outcome.

The document and committed receipt are written atomically. If that response is
lost, cancellation first checks for the committed result. Otherwise it fences
the reservation and records failure in the same transaction. If that transaction
cannot be confirmed, the result remains unknown. Cleanup admission after the
five-minute upload deadline and ten-minute grace also fences the reservation and
records failure. A crash before the provider acknowledges ingestion leaves
provider bytes uncertain and quota charged for manual reconciliation, even when
the receipt proves document creation has failed. Confirmed provider objects are
removed through existing cleanup jobs; capacity is released only after confirmed
deletion or absence. A failed receipt is not a claim that all provider bytes have
been removed. No new storage inspection, replay, or manual-reconciliation
command is supplied by this protocol.

Receipts are retained without automatic expiry, including after cloud document
deletion and failed-upload cleanup. A committed receipt records historical
success; its document ID can refer to a subsequently deleted document. Replay
never recreates it and does not extend retention or grant access. Receipt
metadata is outside the document-byte quota; large-scale receipt compaction and
account erasure policy need a separate design that preserves replay safety.

## Compatibility and rollout

Without the header, multipart upload still returns `201 { "id": "..." }` and
uses the existing reservation/compensation path. It does not deduplicate,
automatically retry, or save a receipt. Legacy CLI upload, browser uploads and MCP clients are
not opted in; explicit `share LOCAL_ID` opts in. New keyed app requests fail closed against an older backend that
does not support receipt admission; they never fall back to unkeyed uploads.

For a future coordinated rollout, deploy the additive schema and compatible
backend before the matching app. Retain receipt rows and reservation
`receiptId` fields on rollback. An old writer does not understand the receipt
fence and must not process in-flight keyed operations; stop admission and let
those operations settle before rolling back. This change performs no deployment.

## Explicit local-first sharing

`share LOCAL_ID` reads daemon-owned immutable snapshot bytes once, preserves local
ID/generation/hash, and stores attempts and receipts by cloud origin and account
in the daemon's existing SQLite owner. Only one invocation receives admission
bytes, after the key is durably recorded. Pending/unknown attempts recover by GET,
without resending bytes. `not_found` is not a cancellation fence. Local success
survives cloud refusal or uncertainty; local and cloud deletion stay independent.

Before admission the CLI sends authenticated `GET /api/documents/upload` without
an operation key and with `Planview-Upload-Protocol: 1`. A compatible server returns
`{version:1, accountId, origin, maxBytes:8388608, receipts:true}` from its configured
origin. This discovery performs no admission. The CLI validates identity/protocol
and uses the captured credential for subsequent requests, with redirects refused.
Legacy discovery failure prevents POST; a response without a matching receipt,
including legacy 201, is never accepted as a committed share receipt.

The daemon retains a finite 10,000 attempts per profile, with bounded local
inspection and direct operation-key lookup. No credentials or snapshot bytes are
stored in attempts. Lost local acknowledgements leave the durable key for lookup;
unknown keys cannot be replaced. A deliberate `--new-attempt` requires terminal
failure. Historical committed receipts can refer to subsequently deleted cloud
documents and never recreate them. These are local source/test capabilities;
compatible hosted app/backend rollout remains a separate operator action. Local snapshots allow 10 MiB, while
cloud uploads allow 8 MiB. The existing local 30-day retention and 1 GiB quota
do not promise permanent offline retention. Explicit generation-bound pin/unpin
is available through the local CLI and manager within the finite quota. Sharing
never pins automatically. Shared local outcomes expose pinned, expiresAt=null
while pinned, and unpinnedExpiresAt for the original access clock. Profile controls
remain pending.
