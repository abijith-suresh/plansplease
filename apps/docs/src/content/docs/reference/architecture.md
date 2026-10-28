---
title: Architecture
description: The boundaries between applications, local packages, authentication, metadata, and file storage.
---
## Applications

| Workspace | Responsibility |
| --- | --- |
| `apps/app` | SolidStart account workspace, auth proxy, cloud upload/preview routes, hosted MCP |
| `apps/site` | Static Astro marketing pages |
| `apps/docs` | Static Astro + Starlight guides and search |
| `apps/cli` | The `plansplease` command and bundled local runtime |

Site and docs have independent builds and deployments. They link to the app;
they do not host its sessions or import its server implementation. The public
product is named plansplease while repository and package identifiers stay planview.

## Local packages

The CLI calls `@planview/local`, which coordinates publication and daemon
lifecycle through typed Effect operations.

| Package | Owns |
| --- | --- |
| `@planview/core` | Document IDs, paths, validation, bundle format, fixed local policy |
| `@planview/local` | Local application API and preparing file/folder snapshots |
| `@planview/daemon` | Detached loopback process, authenticated lifecycle management, HTTP delivery |
| `@planview/storage` | SQLite metadata, immutable files, publication staging/finalization |

Storage does not own URLs or HTTP behavior. Core performs no filesystem or cloud
I/O; its narrow defaults read platform paths and generate IDs. The public CLI
bundles private packages so installation does not require publishing them.

## Cloud data and auth

Better Auth runs through the Convex component. The app proxies auth endpoints
and obtains a Convex token for session-authenticated requests. Convex owns
account/document metadata, owner checks, OAuth state, upload credentials,
quota reservations, durable upload operation receipts, and cleanup jobs. UploadThing owns the file bytes.

Convex has separate API and HTTP action origins. `CONVEX_URL` selects the API
backend; `CONVEX_SITE_URL` selects HTTP/auth actions. Local CLI-generated aliases
are `VITE_CONVEX_URL` and `VITE_CONVEX_SITE_URL`. `SITE_URL` means the **app** public
origin, even though its name might suggest the marketing service.

Browser sessions, upload-only CLI credentials, and MCP OAuth tokens are different
credentials. A CLI token is accepted only by the upload flow. MCP validates its
resource audience and `cloud:documents` scope and binds backend operations to
the authorized account.

## Upload lifecycle on main

1. Validate the HTML bytes and metadata.
2. Reserve the encoded size against the account quota in a backend transaction.
3. Upload to the provider with an absolute deadline.
4. Commit document metadata using short-lived server proofs.
5. Reconcile failure or queue provider cleanup without prematurely releasing quota.

Uncertain provider outcomes stay charged until reconciled. Storage metadata uses
a provider name and logical locator; an owner-bound UploadThing custom ID supports
cleanup even when a provider response is lost. Server proofs do not go to browsers.

Optional [keyed upload operations](../upload-operations/) bind the authenticated
account and configured app origin to exact server-hashed bytes and metadata.
Receipt admission, document commit and failure fencing use the existing backend
transactions; repeated requests return a durable outcome without replaying bytes.
Legacy uploads remain unkeyed. Explicit local-first CLI sharing uses daemon-owned immutable bytes and a durable
local attempt before admission; recovery performs authenticated receipt lookup.

The provider adapter owns uploads, read URLs, and deletion. Standalone HTML
previews download from storage in the browser after the app checks ownership.
Hosted deployment status is in the [features reference](../planned-features/).


Local snapshot inventory and usage pass through `LocalApplication` to the
existing authenticated daemon. The daemon alone opens snapshot metadata.
Selected deletion uses immutable generations, target identity and active-read
leases, with the same mutation gate as publication and cleanup. If metadata
removal succeeds but file removal fails, the snapshot becomes invisible and
bounded reconciliation owns the remaining file. The cloud app and hosted MCP
remain independent of these local operations.


The optional local browser manager is a compiled Solid client served on a second
loopback port in the same daemon process. Its HTTP adapter calls the same daemon
application operations as the native API. It owns no SQLite connection, cloud
client or additional persistent process. Browser sessions and native daemon
credentials are separate. Only packaged trusted assets run on the manager
origin; arbitrary HTML snapshots remain on the preview origin. Both listeners
share lifecycle and stop together. Generation-bound pin/unpin uses shared daemon
operations and SQLite state; automatic cleanup checks current pins at final deletion.
Pins count toward finite quota and do not renew access clocks. Offline profile discovery and native creation share validated directory operations.
Browser selection prepares a CLI instruction and cannot launch or mutate another
profile. No central daemon is introduced; CLI sharing does not expose cloud credentials or mutation to the manager.
