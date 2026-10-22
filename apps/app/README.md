# Planview app

The authenticated product surface is a SolidStart 2 application. Better Auth
and Convex own authentication and document metadata. UploadThing stores hosted
document bytes; the full local workspace uses filesystem storage.

## Full local development

From the repository root, use `npm ci` followed by `npm run local`. This runs the
app with an anonymous local Convex backend, real Better Auth test accounts,
filesystem document bytes, docs, and marketing. It does not require hosted
provider accounts or load existing `.env.local` files. Data survives restart.
Read [the local development guide](../docs/src/content/docs/reference/development.mdx#full-local-workspace) for exact browser,
CLI, MCP, and reset instructions.

## Hosted backend development

From the repository root:

```sh
npm ci
npm run dev --workspace @planview/app
```

The app reads the Convex variables generated in `apps/app/.env.local`. To use
the shared cloud development deployment, select it first and generate the
Convex bindings:

```sh
cd apps/app
npx convex deployment select <team>:<project>:dev/<name>
npx convex dev --once
```

The Convex CLI writes `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`; the server
routes accept those names locally and `CONVEX_URL`/`CONVEX_SITE_URL` on Railway.

## UploadThing setup

Create an UploadThing app, leave file access on the public testing tier, then
copy the app's server token into `apps/app/.env.local`:

1. Create an app at [uploadthing.com](https://uploadthing.com/).
2. Open the app's API key/settings view and copy the complete token value.
3. Add it locally as `UPLOADTHING_TOKEN`:

```text
UPLOADTHING_TOKEN=<token-from-uploadthing>
```

Do not use a `VITE_` prefix. This token is only read by servers. The same
value must be set on the Railway app service and its Convex deployment:
Convex uses it to delete UploadThing files in the background. Deploy the
Convex variable before enabling this deletion flow.

The server upload endpoint accepts standalone HTML or one artifact bundle up to 8 MiB.
See [cloud artifacts](./CLOUD_BUNDLES.md) for folder uploads, supported assets,
preview capabilities, and delivery costs.
The testing tier uses public-read objects, so anyone who
obtains an UploadThing object URL may fetch it. The plansplease preview route
still requires the signed-in workspace session. A future provider such as S3
or R2 can implement the upload, read-URL, and deletion adapter in
`src/lib/document-storage.ts`. Browser, CLI, and MCP uploads reserve the adapter's
predictable provider and locator against the account quota before sending bytes.
The returned locator must match that reservation before committing metadata or
confirming storage for cleanup. The provider's network requests share the
reservation's absolute deadline, including SDK cancellation. Adding a provider
also requires its Convex metadata validation and
background deletion implementation. Convex stores that provider and locator,
not provider-specific bytes. New UploadThing records use an owner-bound custom
identifier as that locator, while older records using raw UploadThing file
keys remain supported during the transition.

After authorizing an owner preview, the app returns a small HTML wrapper. The
browser fetches the HTML bytes directly from UploadThing without credentials or
a referrer, then opens an HTML Blob in an iframe sandbox without same-origin
access. This also handles older CDN responses served as octet-stream attachments.
The browser checks the actual streamed bytes against the 8 MiB limit and shows a
retry action if delivery fails. Inline scripts continue to work, but the document
cannot read the workspace session or the wrapper DOM. Relative assets are not
supported by this standalone HTML flow.

A replacement provider must return an HTTPS read URL with browser CORS support,
including requests with `Origin: null` from the sandbox. Private providers should
return short-lived signed read URLs after app authorization. The provider serves
preview bytes directly, avoiding a second copy through Railway. Provider storage
and bandwidth charges still apply. Legacy Convex previews and bounded MCP reads
continue through the server; this change does not remove their service traffic.
UploadThing objects remain public during this alpha. App authorization, no-store,
and noindex headers do not turn those CDN URLs into private files.

## Authentication setup

Better Auth runs inside Convex. It is not a hosted auth account. The GitHub
OAuth client ID and secret must be set as Convex deployment variables before
the sign-in button can complete:

```sh
npx convex env set BETTER_AUTH_SECRET
npx convex env set SITE_URL http://localhost:3000
npx convex env set GITHUB_CLIENT_ID <github-client-id>
npx convex env set GITHUB_CLIENT_SECRET
```

Do not commit `.env.local`, `.env.staging`, or OAuth secrets. The staging
deployment uses the same functions and has its own values for these variables.

Generate a random `DOCUMENT_MUTATION_SECRET` of at least 32 bytes and set the
same value in the app server environment and its Convex deployment. It signs
short-lived proofs for metadata creation. Uploads
will fail closed until both sides have this value.

## Hosted MCP

The cloud agent endpoint is `${SITE_URL}/mcp`. It uses Better Auth 1.7 OAuth
with Client ID Metadata Documents (CIMD), account sign-in, explicit consent,
and a `cloud:documents` scope. Agents can list, read, upload, and delete only
the signed-in account's cloud documents. `read_document` returns at most 32,768
characters per call; repeat with `nextOffset` to read the rest. Uploads accept
one HTML document or artifact bundle up to 8 MiB. `upload_bundle` accepts UTF-8
assets, and `list_bundle_files` lists their paths. `read_document` accepts an
optional asset `path`. `upload_document` returns `{ id, url }`, where
`url` is the account workspace preview and requires the owning account to be
signed in. It is not an anonymous share link or a direct storage URL.
There is no document count quota during
development. Deletes hide the document and queue storage cleanup; the existing
Convex retry worker finishes cleanup in the background. UploadThing files have
public URLs during development, including files uploaded through MCP.

The app and Convex deployment both need the same public `SITE_URL` and a
random `CIMD_FETCH_SECRET` of at least 32 bytes. The Convex HTTP runtime sends
CIMD metadata requests to the app's private
`/api/internal/cimd-fetch` endpoint; the Node transport validates DNS and pins
the connection to a public address. Set `CONVEX_SITE_URL` on the app so it can
proxy OAuth endpoints and authorization server metadata. Configure
`DOCUMENT_MUTATION_SECRET` and `UPLOADTHING_TOKEN` on both app and Convex as
described above. Set these variables on the Convex deployment before deploying
the app, then deploy the app with the same `SITE_URL`.

OpenCode 1.x uses the older MCP transport. For a staging compatibility test,
set `MCP_ALLOW_LEGACY_CLIENTS=true` on both the app and Convex before deploying.
This enables stateless support for older MCP requests and Dynamic Client
Registration. OpenCode 1.18 does not mark its HTTP loopback callback as a native
client during registration, so register a native public client with the
`http://127.0.0.1:19876/mcp/oauth/callback` redirect URI and set its `clientId`
in OpenCode's MCP OAuth config. Leave the flag unset to serve only MCP
2026-07-28 with CIMD. MCP access tokens require a user authorization code;
client credentials cannot access cloud documents.

The current Convex Better Auth adapter is still published against Better Auth
1.6 and imports a provider removed in 1.7. The repository's postinstall and
build hooks remove that obsolete adapter hook from the installed package; the
new OAuth provider owns the agent flow. The auth component is installed locally
under its original `betterAuth` name, with a schema that retains the existing
tables and adds the 1.7 OAuth tables. Review an adapter upgrade before removing
the compatibility hook. To regenerate its schema, run
`node scripts/prepare-auth-adapter.mjs` from the repository root, then from
`apps/app` run:

```sh
npx auth@latest generate --config ./convex/betterAuth/auth.ts --output ./convex/betterAuth/generatedSchema.ts --yes
```

The generated file should retain its repository header. OAuth account sign-in
requires the existing GitHub provider configuration. Point an MCP client at
`${SITE_URL}/mcp`; it discovers the protected resource and authorization server
through `/.well-known/` metadata, then requests consent in the browser.

## Deployment contract

Railway deploys from the repository root. The service should use:

```text
Build: npm run build --workspace @planview/app
Start: npm start --workspace @planview/app
Health check: /api/health
```

The current staging service is configured with that contract. It needs
`CONVEX_URL`, `CONVEX_SITE_URL`, `UPLOADTHING_TOKEN`, `DOCUMENT_MUTATION_SECRET`,
`CIMD_FETCH_SECRET`, and `SITE_URL` before OAuth and cloud uploads can be tested.

## Current API surface

- `/api/auth/*` proxies Better Auth to the Convex site.
- `/mcp` is the OAuth protected hosted agent endpoint. The OAuth metadata
  lives at `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server/api/auth`.
- `GET /api/documents` lists the signed-in user's documents.
- `GET /api/documents?limit=50` returns a page with `page`, `isDone`, and
  `continueCursor`. Pass `cursor=<continueCursor>` to read the next page. The
  limit must be between 1 and 100. Requests without pagination parameters
  retain the original array response for existing clients.
- `POST /api/documents/upload` uploads HTML or a validated bundle and records its metadata
  in one server request. It accepts either a web session or a CLI upload-only
  credential; CLI credentials cannot list, view, or delete documents.
- `POST /api/cli/session` issues a revocable upload-only credential after the
  signed-in user approves the local CLI in the browser.
- `DELETE /api/cli/session` revokes the presented CLI credential.
- `GET /api/documents/:id` views a workspace document.
- `DELETE /api/documents/:id` returns `202 Accepted` for UploadThing documents
  after marking them hidden. A Convex worker deletes the file and metadata in
  the background. Failed attempts use exponential backoff, and a one-minute
  reconciliation job recovers interrupted workers. Legacy Convex-stored
  documents are deleted in the mutation and return `204 No Content`.
- `/api/health` is the Railway health check.

Document previews are authorized through the user's Convex session and served
inline with a sandboxed, opaque origin. This lets agent-generated HTML run its
own scripts without giving it access to the app session or same-origin
application APIs. Existing Convex-backed records remain readable while the
new provider boundary is rolled out. Bundles and private storage are later
slices.

## Account storage quota

Cloud accounts have a default storage quota of 500 MB, or 500,000,000 bytes.
Set `ACCOUNT_STORAGE_QUOTA_BYTES` to a positive integer in the Convex deployment
if a different limit is needed. The app and CLI do not set this value.

Browser, CLI, and MCP uploads reserve capacity in one backend transaction before
sending any file bytes. Existing documents, documents waiting for storage deletion,
and pending or failed uploads all count toward the limit. Lowering the limit does
not delete existing documents; it prevents uploads until enough capacity is free.
The single-object limit is 8 MiB, including a bundle manifest and all its assets. The account limit uses decimal MB;
the file limit uses binary MiB.

A reservation allows five minutes for uploading. UploadThing requests use that
absolute deadline. Provider-confirmed uploads whose metadata failed wait another ten minutes before
storage cleanup. Cleanup retries durably, and capacity is released only after the
provider confirms deletion or that the object is absent. Uploads with unknown
provider outcomes, including process crashes and network timeouts, stay charged
for manual reconciliation. A deadline or an absence check cannot prove a remote
ingest has stopped, so these reservations are never automatically released.
An ambiguous metadata response is checked transactionally before cleanup, so a
successful upload is preserved even if its first response was lost. If reservation
cancellation cannot reach Convex, the scheduled worker still reconciles it.

Quota admission uses one materialized counter per account after a one-time seed
from existing document and reservation metadata. Reserving increments it;
committing exchanges a reservation for a document without changing the total.
Successful storage cleanup or deletion decrements it in the same transaction
that removes metadata. Pending deletions and unknown upload outcomes stay charged.
The first seed may hit Convex transaction read limits for a very large legacy
account; admission then fails closed. Such accounts need a paged administrator
backfill during maintenance before accepting uploads. This alpha implementation
has no billing or paid storage tiers.

### Deployment order

This change requires a short upload maintenance window. Do not roll the new
backend underneath an old app that still uploads before creating metadata.

1. Stop the app service accepting new uploads and let existing upload requests
   finish. Wait for the existing provider requests to settle before proceeding.
2. Deploy the Convex schema and functions, including the account counters,
   reservations, and cleanup worker. Existing read and deletion endpoints remain
   available in Convex. New metadata creation now requires a reservation.
3. Deploy the matching app release, then resume the service. Check a small upload
   through CLI or MCP, confirm its reservation was exchanged for a document, and
   check the counter matches retained bytes.

Keep the app and backend on this reservation flow together. App rollback to a
pre-quota release requires another maintenance window and backend rollback;
otherwise old uploads can store bytes and then fail reservation validation.
If a pre-quota backend ever resumes accepting writes, rebuild usage counters from
retained documents and reservations during maintenance before reenabling quotas.
No deployment, backfill, or cleanup is performed by this code change.
