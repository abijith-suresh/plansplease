# Self-hosting plansplease

Status: proposal. No Docker packaging, authentication, storage, or deployment
behavior changes in this PR. Sources and repository constraints checked 2026-10-01.

Offer one supported installation for a single home server: a pinned Docker Compose
release with the web app, self-hosted Convex, its admin dashboard, and a reverse
proxy. Store documents on the server through Convex file storage first. Keep a
managed Convex backend optional. A paid storage or authentication subscription
should not be required to run the application.

The hosted alpha can keep public UploadThing files for now. Self-hosting is a
separate release, and this proposal does not switch the alpha provider or migrate
its documents. A later hosted private-storage option around the user's $10 budget
should use the same provider boundary, with an eventual S3 option kept possible.

## What exists and what needs work

The app runs as a Node server and already accepts `CONVEX_URL`, `CONVEX_SITE_URL`,
and `SITE_URL`. Better Auth runs in a locally mounted Convex component. Its setup
includes the current adapter compatibility hook and hosted MCP OAuth plugins.
Changing URLs alone has not been tested as a complete self-hosted installation.

New uploads currently require UploadThing in both the web and MCP paths.
The merged `DocumentStorageAdapter` supplies read URLs and deletion.
[PR #128](https://github.com/abijith-suresh/planview/pull/128), currently unmerged,
proposes adapter-owned uploads, deterministic reservation locators, and absolute
upload deadlines. That would improve the upload boundary, while metadata
validation, mutation proofs, and background deletion would still assume
UploadThing. Legacy Convex-backed previews exist, but they do not constitute a
supported new-upload workflow. A self-hosted release must implement and test the
complete provider contract for local or private storage.

[Convex documents self-hosting](https://docs.convex.dev/self-hosting) and provides
[a Docker setup](https://github.com/get-convex/convex-backend/blob/main/self-hosted/README.md)
with a persistent volume and a SQLite default. This makes retaining the current
backend a plausible first implementation. It does not prove that our exact Better
Auth component, OAuth plugins, signing-key behavior, or adapter hook work against
a given self-hosted backend image. Verify that combination before promising support.

## Smallest supported first release

Support one server and one installation, with two ownership accounts tested.
Keep the current GitHub sign-in and standalone HTML upload limit. Defer clustered
hosting, Postgres administration, multiple authentication providers, folder uploads,
and a standalone replacement for Convex.

| Service | Purpose | Data and access |
| --- | --- | --- |
| Web app | Workspace, CLI callbacks, MCP and sandboxed previews | Public HTTPS entry; no Convex admin key in the runtime app |
| Convex backend | Metadata, auth component, functions and document files | Persistent volume; client API and HTTP actions routed separately |
| Convex dashboard | Operator management | Localhost or private management access; requires admin key |
| Reverse proxy | TLS and routing | Persistent certificate state; public access only for intended endpoints |

Ship tested application and backend image versions. Do not use mutable `latest`
tags in the supported example. Include a pinned tools container for initialization,
deploying backend functions, backup, and upgrade tasks so operators do not need
Node tooling installed on the host.

The intended setup is to choose the app and backend origins, generate independent
secrets, start the backend, deploy our functions once, configure GitHub OAuth, and
start the app. Provide a short guided command for that sequence with clear health
and configuration failures. A plain `docker compose up` must not imply that
unconfigured auth, backend functions, or storage are ready.

Keep an optional app-only Compose profile for operators who deliberately use a
managed Convex deployment. Label it as dependent on that provider's limits and
availability. The full local profile must not require a Convex cloud account,
UploadThing token, or paid SaaS account.

## Origins, TLS, and home-server access

Use a root app origin such as `https://plans.home.example`. Supply tested reverse
proxy examples for the app, Convex API, and Convex HTTP actions, plus a private
dashboard endpoint. Convex documents [separate API and HTTP-action origins](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/hosting_on_own_infra.md).
Forward WebSocket traffic for clients using subscriptions. Preserve the external
host and scheme through a trusted proxy; do not trust client-supplied forwarding
headers indiscriminately.

`SITE_URL` on both the app and the backend must identify the external app origin.
Convex's `CONVEX_CLOUD_ORIGIN` and `CONVEX_SITE_ORIGIN` identify the backend endpoints,
not the app. App `CONVEX_URL` and `CONVEX_SITE_URL` must agree with those endpoints
and be reachable from the relevant containers. Browser-facing URLs must resolve
from the operator's machine, not just Docker's internal network.

The backend must also reach the app's CIMD metadata-fetch route for modern MCP
authorization. Test container routing and public-host loopback with the chosen
TLS setup. A LAN name that works in the browser but fails inside Convex is not a
working MCP deployment. Third-party metadata retrieval needs outbound access.

Provide a local loopback development profile and a home-server HTTPS profile.
Current CLI origin validation permits plain HTTP only for `localhost` and
`127.0.0.1`; a raw LAN HTTP address is not supported. A locally trusted certificate
must be trusted by the browser, CLI, and backend clients. Keep the admin dashboard
and deployment credentials off the public internet. Home networking, DNS, and
certificate issuance remain operator prerequisites, with an explicit checklist.

The CLI already selects another instance through:

```sh
planview --profile home login --cloud-url https://plans.home.example
planview --profile home upload ./plan.html
```

MCP clients use `https://plans.home.example/mcp`. A sign-out marketing destination
should be configurable; a custom installation without one should stay on its
local signed-out page. Never send a self-hosted user to our staging app or site.

## Authentication

Retain Better Auth and the existing GitHub provider first. The operator creates
their own OAuth registration and sets its callback to
`<app-origin>/api/auth/callback/github`. GitHub remains an external dependency,
but no paid authentication service is mandatory. Fully offline or GitHub-free
authentication is a separate choice, not part of this first-release promise.
[Better Auth's GitHub setup](https://better-auth.com/docs/authentication/github)
requires provider credentials and the matching callback.

Generate `BETTER_AUTH_SECRET`, `DOCUMENT_MUTATION_SECRET`, and `CIMD_FETCH_SECRET`
once per installation, and persist them outside images. Set explicit auth base URL
and narrowly scoped trusted origins as recommended by the
[Better Auth options documentation](https://better-auth.com/docs/reference/options).
Keep the Convex admin key in the initialization/backup tools, not in browser code
or normal app containers. A new container must not regenerate signing secrets and
silently invalidate sessions.

Before release, test component deployment, session creation, JWT validation,
cookie forwarding, OAuth consent, signing-key persistence, and MCP authorization
with the exact pinned versions. Preserve the repository's adapter preparation
hook until an independently tested upgrade removes it. Convex's separate
`@convex-dev/auth` setup guidance is not evidence for our Better Auth integration.

## Document storage and delivery

Default to Convex file storage on its persistent local volume for the smallest
stack. Authenticate each document read and return its bytes through the app's
sandboxed preview path. Do not expose permanent bearer file URLs as private.
[Convex file-serving guidance](https://docs.convex.dev/file-storage/serve-files)
distinguishes direct URLs from authenticated HTTP actions, which have a 20 MB
response limit. Keep our 8 MiB HTML limit until the full read path is tested.

Extend the provider contract to include upload, authenticated byte reads, deletion,
and locator validation. Keep provider/key metadata explicit and proof-bound.
Handle publication failure and durable orphan cleanup independently from document
deletion. Existing UploadThing documents must remain readable and deletable when
their credentials are present. Reject unsupported combinations at startup.

Serve preview bytes with the current opaque-origin sandbox, content security
policy, and private cache controls. Generated HTML may load remote scripts or
assets, so local storage does not make the document offline. Downloads consume
home-server bandwidth; a proxy does not remove delivery costs.

Offer S3-compatible storage after the local default works. Test endpoint URL,
region, path-style access, private buckets, upload/read/delete, and backups against
one named implementation before claiming broad compatibility. Operators could use
their own object server or a cloud bucket. Direct short-lived signed downloads
can reduce app traffic, but grant bearer access until expiry; private preview HTML
still needs isolation and the intended authorization policy.

Convex also supports [backend-level S3 storage](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/s3_storage.md).
That configuration includes modules, files, and other backend data. It is distinct
from implementing an application storage adapter, and switching it requires data
migration. Do not treat an S3 environment variable as migrating UploadThing files.

## Persistence, backups, and upgrades

Persist the complete Convex data volume and proxy certificate state. Back up
configuration, secrets, pinned image versions, backend code, auth-component data,
and document bytes. Container replacement must preserve accounts and files.
Expose disk usage and failed cleanup jobs; fail an over-limit upload before filling
the host disk. An operator backup path must be outside disposable containers.

Support a scheduled backup command and a documented restore onto an empty server.
Use Convex [exports including file storage](https://docs.convex.dev/cli/reference/export)
where appropriate, and verify that the selected export/restore procedure covers
component tables as well as root documents. Include an independently tested
consistent volume backup if export alone cannot preserve everything. Never copy
a live SQLite database file casually and call it a consistent backup.

Follow the upstream [upgrade guidance](https://github.com/get-convex/convex-backend/blob/main/self-hosted/advanced/upgrading.md):
back up first, allow migrations to finish, and test restore before changing images.
Pause writes for a coordinated export if needed. Data exports do not replace a
backup of configuration, secrets, and release versions. An older image may not
read a migrated database; rollback requires a compatible backup, not just a tag.
Verify identity and credential behavior after restore instead of promising that
all old sessions survive.

## Implementation order and acceptance checks

First prove the pinned backend/auth combination in a disposable local stack.
Then implement local storage uploads, package the images and guided setup, and
add backup/upgrade tooling. Broader S3 support follows that supported installation.

- A clean host with Docker can initialize without a paid SaaS account and without
  local Node tooling; missing OAuth/configuration yields actionable errors.
- Browser sign-in, CLI login/upload, document listing/preview/deletion, and modern
  MCP consent/read/upload work through HTTPS and the reverse proxy.
- Two accounts cannot read or delete each other's documents; raw storage reads
  do not bypass ownership, and generated HTML cannot read application cookies.
- Restarting containers and recreating them preserves data and signing keys.
- Network failures, failed publication, cleanup retries, and disk exhaustion do
  not corrupt committed documents or report false success.
- Backup and restore recover accounts, component state, metadata, and file bytes
  on an empty server; the procedure records any required reauthorization.
- Upgrade and rollback use tested version pairs and backups. Custom origins never
  normalize to our hosted staging URL.
- No admin key or object-store secret appears in browser bundles or routine logs.

Before implementation, decide whether GitHub-dependent login is sufficient for the
first release, whether a home server or a managed backend is the primary audience,
and whether S3 support must ship alongside local storage. Validate supported CPU
architectures and publish measured hardware requirements after the prototype;
this proposal makes no one-click or minimum-memory claim yet.
