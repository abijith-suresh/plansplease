# Planview app

The SolidStart app owns account authentication, cloud document routes, and hosted
MCP. Convex stores account and document metadata; UploadThing stores hosted file
bytes. The [local development guide](../docs/src/content/docs/reference/development.mdx#full-local-workspace)
uses filesystem storage and needs no hosted provider accounts. Hosted service
availability is tracked in the [features reference](../docs/src/content/docs/reference/planned-features.md).

## Local development

From the repository root:

```sh
npm ci
npm run local
```

For a hosted development backend, select a development Convex deployment and
generate its bindings:

```sh
cd apps/app
npx convex deployment select <team>:<project>:dev/<name>
npx convex dev --once
```

Then run `npm run dev --workspace @planview/app` from the repository root.
Use `apps/app/.env.example` for environment names. `SITE_URL` is the public app
origin; `CONVEX_URL` and `CONVEX_SITE_URL` select Convex API and HTTP origins.

## Hosted provider setup

Create an UploadThing app and keep file access on its public testing tier. Store
the complete server token as `UPLOADTHING_TOKEN`; do not use a `VITE_` prefix.
The app server and Convex deployment must use the same token because Convex
deletes provider files in the background. Configure Convex before enabling that
deletion flow.

The app and Convex deployment also need matching `SITE_URL`,
`DOCUMENT_MUTATION_SECRET`, and `CIMD_FETCH_SECRET` values. The mutation secret
must contain at least 32 random bytes and signs short-lived metadata proofs. The
CIMD secret must contain at least 32 random bytes. Configure backend values
before deploying the app. GitHub OAuth credentials belong in Convex, not in
client-visible variables.

UploadThing's alpha objects have public direct URLs. Workspace ownership checks,
preview sandboxing, `no-store`, and `noindex` headers do not make those objects
private. Avoid secrets and sensitive documents. The preview route authorizes the
owner before issuing a short-lived read capability; each asset request checks
current ownership before serving or using cached data. Previously downloaded
copies cannot be revoked.

## Upload and recovery contract

The app accepts standalone HTML and artifact bundles. Bundles need root
`index.html`, contain at most 512 files, and are limited to 8 MiB including the
manifest. CLI uploads support the documented binary asset formats; MCP bundle
uploads accept UTF-8 text assets. See the [cloud guide](../docs/src/content/docs/guides/cloud.mdx)
and [CLI reference](../docs/src/content/docs/guides/cli.mdx#cloud-upload) for user-facing behavior.

Bundle asset delivery passes through each app process. Its cache holds at most
two bundle objects (up to 8 MiB each), allows two concurrent provider reads, and
expires entries after one minute. Every asset request checks current ownership
before using cached bytes. This preserves relative asset URLs but consumes app
bandwidth; provider storage and delivery charges also apply. Owner preview
capabilities expire after five minutes and are renewed by reopening the stable
preview URL.

The account quota defaults to 500,000,000 bytes and can be changed with a
positive `ACCOUNT_STORAGE_QUOTA_BYTES` value in Convex. Uploads reserve capacity
in a backend transaction before bytes are sent. Committed documents, active
reservations, pending deletions, and uncertain provider outcomes remain charged.
Cleanup releases capacity only after the provider confirms deletion or absence;
an unknown outcome requires reconciliation. Each reservation has a five-minute
upload deadline, and provider requests share that deadline. A provider-confirmed
upload whose metadata commit failed waits ten minutes before cleanup. The first
quota-counter seed can exceed Convex transaction read limits for a very large
legacy account; admission fails closed until an administrator backfills it.

The provider adapter in `src/lib/document-storage.ts` owns upload, read-URL, and
deletion operations. Providers must return the locator reserved before upload;
the app checks that match before committing metadata. Requests share the
reservation deadline, including SDK cancellation. A new provider also needs
Convex metadata validation and background deletion support. Convex stores the
provider and logical locator, not file bytes. Legacy records with raw UploadThing
keys remain readable during the owner-bound locator transition.

Keep the app and Convex backend on compatible reservation-aware releases. Before
deploying a backend that requires reservations, stop uploads, let in-flight
provider requests settle, deploy the backend, then deploy the matching app and
verify a small upload and quota counter. Rolling back to an older uploader also
requires a coordinated maintenance window and backend rollback; a pre-quota
uploader can store bytes before reservation-required metadata creation fails. If
a pre-quota backend accepted writes, existing `accountStorageUsage` rows may be
stale and are reused without rescanning documents. Rebuild counters from retained
documents and reservations with a paged maintenance backfill before reenabling
quota admission. No backfill command is implemented here.

## Authentication and MCP

Better Auth runs through the Convex component. OAuth sign-in uses the GitHub
provider configured in Convex. The MCP endpoint is `${SITE_URL}/mcp`; it grants
the signed-in account `cloud:documents` access. CLI credentials are upload-only
and cannot be used as MCP tokens. `read_document` returns up to 32,768
characters per call; bundle paths can be listed and text assets read separately.

OpenCode clients that need the older MCP transport require
`MCP_ALLOW_LEGACY_CLIENTS=true` on both app and Convex before deployment. Keep it
unset to serve the default CIMD OAuth flow.

## Optional keyed upload operations

The existing authenticated upload route supports an opt-in `Idempotency-Key`
header and authenticated receipt lookup on `GET /api/documents/upload`. Convex
retains account/origin-specific receipts and binds each key to the server-hashed
exact bytes and normalized metadata. Concurrent/repeated requests never start a
second provider upload. Commit, failure fencing, quota and cleanup use the
existing transactions and ownership checks. A pending receipt or unavailable
backend means an unknown outcome; it does not authorize replay.

See the [upload operation protocol](../docs/src/content/docs/reference/upload-operations.md)
for statuses, fingerprints, crash recovery limits, retained receipt metadata and
compatible rollout/rollback requirements. The explicit CLI `share LOCAL_ID` command opts in; legacy upload has no automatic
retry. Legacy unkeyed uploads remain compatible.

Local protocol fixtures use the production HTTP handlers, proof verification,
mutation functions and filesystem adapter with a transaction retry/rollback
model. They do not run a Convex service or contact UploadThing. Run `npm run test:upload:installed` from the root to pack/install the real CLI in an isolated
prefix, exercise its unchanged legacy upload over loopback HTTP, then exercise
keyed upload/replay/receipt lookup and installed share through the actual daemon
and SQLite owner, including loss/concurrency/restart/bundles/account/origin cases. Set `TARBALL` to
reuse an already built package. This is a local fixture, not hosted-provider or
native corporate-laptop proof.
