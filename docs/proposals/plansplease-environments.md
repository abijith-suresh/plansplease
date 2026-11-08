# Plansplease naming and environments

Status: alpha environment decisions accepted on 3 October 2026; production setup deferred pending owner provider configuration.

The owner selected public UploadThing storage for the small alpha and generated
Railway domains. Friends should use a separate, stable production environment;
staging remains available for development and breaking changes. Infrastructure
must stay within Railway Hobby, use the smallest practical setup, and report costs
before provisioning. No paid Convex or UploadThing plan is authorized.

Production must have independent Convex data, a separate UploadThing app, GitHub
OAuth registration, and independently generated signing/auth secrets. Production
promotes reviewed commits deliberately; staging development must not deploy over
friends' running release. Keep the GitHub repository and internal package/data
identifiers compatible. The CLI command is already `plansplease` after PR #135.

The original hostname cutover below is retained as historical operational context.
It does not authorize repeating that cutover or changing staging credentials.

## Current state and proposed names

| Resource | Current | Proposed |
| --- | --- | --- |
| Product | plansplease | plansplease |
| GitHub repository | `abijith-suresh/planview` | Keep during alpha; any rename needs a separate automation migration |
| Railway project | `planview-cloud` | Keep for now; display rename is optional |
| Railway app services | Staging `app`; empty production `plansplease-app-alpha` | Keep explicit environment/service IDs |
| Railway site service | `plansplease-site` | Keep |
| Staging app origin | `https://plansplease-app-staging.up.railway.app` | Keep the user-selected host |
| Staging site origin | `https://plansplease-site-staging.up.railway.app` | Keep |
| Production app origin | Reserved `plansplease-app-alpha-production.up.railway.app`; no deployment | Use generated Railway domains during alpha |
| npm package and CLI | `@abijith-suresh/planview`, `plansplease` | Keep; npm publication is still disabled |
| Workspace package names, local data paths, environment variable names | Existing `planview` identifiers | Keep until a separate compatibility release |

Railway already has `staging` and `production` environments. Production has a
reserved app domain and empty services. The owner wants production for friends
and staging for development.
The production resources below still require provisioning and verification.

## Approved staging cutover

The existing generated app domain, ID `38b5df65-9796-46ac-a110-06d8a8c1ad6a`,
was renamed from `app-staging-a39a.up.railway.app` to
`plansplease-app-staging.up.railway.app`. Railway reports it as `ACTIVE`.

These settings now use `https://plansplease-app-staging.up.railway.app`:

- Railway staging app `SITE_URL`.
- Convex deployment `tame-dolphin-986` `SITE_URL`. Convex labels this deployment
  as production in its CLI; it is the existing backend used by Railway staging.
- Railway staging site `PUBLIC_APP_URL`.

The app and site use reviewed merged commit
`476480e798bdff60b61be8b975d8d72bc3a009fa`. No unmerged UI or marketing changes
were deployed. Railway production, GitHub OAuth settings and secrets, documents,
and storage remain unchanged.

Both submitted deployments reached `SUCCESS`:

- App `b8038440-2f05-43ec-93e5-288478227077`.
- Site `cfc70c1f-d56b-4a09-8210-72a77af27913`.

The new app health check and both MCP/OAuth discovery endpoints return `200` and
advertise the new host. GitHub sign-in initiation returns `302` with the new
callback. The staging site health check returns `200`, and its dashboard link
uses the new app host with no old hostname remaining in the rendered page.
The owner subsequently updated the GitHub callback to
`https://plansplease-app-staging.up.railway.app/api/auth/callback/github` and
personally confirmed that sign-in reached the dashboard. Complete new-client MCP
authorization has not been reverified after that manual change. The tested CLI
compatibility change merged in PR #127 updates the default and normalizes the old
staging origin to the new one for saved-credential recovery. npm publication
remains disabled. Existing installs and credentials must not be assumed to use
the new host until that source change is released and installed.

## Original cutover runbook and recovery requirements

The following is the reviewed forward-cutover reference. The domain and origin
settings have already changed; do not repeat the old-host rename command.
The user explicitly accepted the sign-in and CLI interruption instead of waiting
for the prerequisites below. Retain them for recovery and future origin changes.

The current app is healthy at `/api/health`. MCP discovery and GitHub sign-in both
use the current app origin. Railway allows one generated domain per service.
[Renaming it](https://docs.railway.com/cli/domain) replaces the old host, so existing
links cannot be assumed to redirect.

The GitHub OAuth client in use is `Ov23liMcd6zsqoA4GYKE`. Before the cutover, a
live sign-in request produced this callback:

```text
https://app-staging-a39a.up.railway.app/api/auth/callback/github
```

The OAuth app's saved callback setting has not been inspected. Its owner must
update the callback to the new origin during the cutover. GitHub checks the
[redirect URL against the registered callback](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#redirect-urls).
Changing only the Railway domain would risk breaking the test experience.

At the original cutover, the CLI embedded the old host in
`apps/cli/src/cloud.ts` as `DEFAULT_CLOUD_URL`.
Saved credentials contain their own `cloudUrl`, which uploads and revocation use.
Setting `PLANVIEW_CLOUD_URL` changes the next login destination; it does not migrate
an existing saved credential. Login revokes the previous credential before saving
the replacement, so a credential pointing at a removed host can block re-login.

Before cutover, prepare a separate, tested CLI compatibility release that updates
the default origin and provides recovery for saved old-host credentials. Do not
rename the binary, npm package, profile paths, or credential format as part of that
release. Publish it when the new origin is ready. Until that release is available,
only proceed if every current CLI tester can run `planview logout` against the old
host before it disappears, in every profile they use:

```sh
planview logout
planview --profile testing logout
```

Use actual profile names instead of the `testing` example. Do not silently delete
credential files and leave their server tokens active. An offline tester who misses
logout needs the compatibility recovery flow to revoke the old token through the
confirmed replacement backend and save a fresh credential. That recovery must not
send tokens to an arbitrary new origin. Wait for that release if this cannot be
handled safely for all current testers.

Prepare the GitHub OAuth app settings page before running the commands below.
Use a short maintenance window, with no sign-ins or MCP authorizations in progress.
If the domain rename fails, stop and leave the current callback and origins intact.
The initial availability read returned `Not Authorized`. The later authorized
rename confirmed that the user-selected hostname was available and is now active.

The following commands use the verified IDs and Railway CLI 5.63.1. Run them from
the app directory in a clean checkout, with Convex CLI access to `tame-dolphin-986`.
They record the original cutover, not commands to run when merging this proposal.

```sh
plansplease_project=306aabd5-d0a6-4f2b-854b-b8d457330eed
plansplease_staging=96e86b54-72cf-4fa7-b5dc-72392499e825
plansplease_app=bd2ef5a6-0b2c-45c6-99ad-87401648bc25
plansplease_site=a3a90792-088c-4db5-86d6-2478f7d85757
plansplease_origin=https://plansplease-app-staging.up.railway.app

railway domain list --project "$plansplease_project" \
  --environment "$plansplease_staging" --service "$plansplease_app" --json

railway domain update app-staging-a39a.up.railway.app \
  --domain plansplease-app-staging \
  --project "$plansplease_project" --environment "$plansplease_staging" \
  --service "$plansplease_app" --json
```

After Railway confirms the exact new host, update the GitHub OAuth app's
authorization callback to:

```text
https://plansplease-app-staging.up.railway.app/api/auth/callback/github
```

Update its homepage URL too. Then make the Convex auth origin, app runtime origin,
and site link agree. Use the actual confirmed host if the preferred label was
unavailable.

```sh
npx convex env set SITE_URL "$plansplease_origin" --deployment tame-dolphin-986

railway variable set "SITE_URL=$plansplease_origin" \
  --project "$plansplease_project" --environment "$plansplease_staging" \
  --service "$plansplease_app"

railway variable set "PUBLIC_APP_URL=$plansplease_origin" \
  --project "$plansplease_project" --environment "$plansplease_staging" \
  --service "$plansplease_site"

railway deployment list --project "$plansplease_project" \
  --environment "$plansplease_staging" --service "$plansplease_app" --json
railway deployment list --project "$plansplease_project" \
  --environment "$plansplease_staging" --service "$plansplease_site" --json
```

Variable changes trigger deployments. Record each deployment ID and wait for that
deployment's `SUCCESS`. Deploy merged code only. `PUBLIC_APP_URL` is used by the
site build, so a successful app restart alone does not update the marketing link.
Convex `SITE_URL` changes also change the trusted origin and OAuth issuer.

After the new origin works, testers who logged out can sign in and upload with an
explicit destination even before installing the CLI release with its new default:

```sh
PLANVIEW_CLOUD_URL=https://plansplease-app-staging.up.railway.app planview login
planview upload --open ./report.html

planview --profile testing login --cloud-url https://plansplease-app-staging.up.railway.app
planview --profile testing upload --json ./report.html
```

An environment variable only on `upload` cannot override the saved destination.
Older CLI versions without a new login still point to the removed host and will
fail. Update bundled examples and the CLI default in the compatibility release.

Before announcing the new URL, verify:

- `GET /api/health` returns `{"status":"ok"}` on the new app host.
- `/.well-known/oauth-protected-resource/mcp` advertises the new `/mcp` resource.
- `/.well-known/oauth-authorization-server/api/auth` advertises the new issuer,
  authorization endpoint, and token endpoint.
- `/auth/github` returns a GitHub redirect with the new callback. Complete an
  actual sign-in and return to the dashboard; a redirect alone cannot verify the
  callback setting.
- A fresh MCP connection authorizes, lists documents, and uploads a test document.
  Existing clients must update the server URL and may need to authorize again.
- CLI login, upload, and logout succeed on the new host for the default profile and
  an isolated profile. Test the compatibility release with a saved old-host
  credential and an unreachable old origin, including failed revocation. Confirm
  failures preserve the old credential and clean up any newly issued token.
- The staging site links to the new app, and an existing document preview opens.

Update README links only after these checks pass. Existing app sessions are tied
to the old host, so tell testers to sign in again. Old document links also need
the new host. A future owned domain avoids repeating this migration when switching
hosting providers.

For rollback, rename the generated domain back if Railway still permits that
label. Restore `SITE_URL` in both Convex and Railway, `PUBLIC_APP_URL` on the site,
and the GitHub callback to `https://app-staging-a39a.up.railway.app`. Wait for the
app and site deployments to succeed and repeat the checks above. Reclaiming the
old generated label is not guaranteed; keep the actual active domain consistent
across all four settings if reclamation fails.

Before removing the new host during rollback, prepare and publish a tested
rollback CLI release that removes or reverses the forward old-to-new origin alias
and restores the appropriate default. The merged forward compatibility change
normalizes even an explicit `--cloud-url` old origin to the new host, so that flag
alone cannot target a restored old host. Keep the new host active until credential
revocation and recovery have been handled if a rollback CLI is not yet available.

CLI testers must log out on the new host in every active profile before it is
removed. After installing the rollback CLI and verifying the restored host, use
`planview login --cloud-url https://app-staging-a39a.up.railway.app` in each profile.
Verify login, upload, logout, and recovery of saved new-host credentials when the
new host is unreachable, including preservation on failed revocation. Do not
assume reverting Railway variables fixes the CLI default, alias, or credentials.

## Stable production for friends

The owner deferred provider setup on 3 October 2026. Prepare the existing Railway
production environment using one app replica and
small separate static site/docs services. Keep builds at the monorepo root and
use each workspace's build/start commands. No Railway database, persistent volume,
additional replicas, custom domain purchase, or Pro-only feature is needed.

Use independent resources:

- A separate Convex deployment and GitHub OAuth app with a production callback.
- A separate public UploadThing app and independently generated signing/auth secrets.
  Do not clone staging secrets, accounts, sessions, or test documents.
- App, backend, site, and docs built from one reviewed release. Promote an explicit
  commit, record deployment IDs, verify health/auth/upload/preview/delete/MCP, and
  keep the prior release for coordinated rollback. Never deploy an unreviewed
  staging branch automatically to production.
- Environment-specific app/backend origins and site/docs links. CLI friends use
  `plansplease login --cloud-url <production-origin>` until a reviewed distribution
  changes the default; existing staging credentials remain bound to staging.

### Cost check before setup

Checked on 3 October 2026. Railway reports $0.69 of current-period project usage.
Last-day average memory is approximately 0.101 GB for app, 0.053 GB for site, and
0.049 GB for docs. Doubling those idle footprints gives approximately $4.04/month
of RAM usage at Railway's current per-second rate, before CPU and traffic. This
is an estimate from a lightly used staging deployment, not a production bill.

[Railway Hobby](https://railway.com/pricing) has a $5 monthly minimum with $5 of
usage included; excess usage is billed. Hobby is not a $5 spending cap. Keep one
replica per service and inspect actual memory and egress after deployment rather
than upgrading the plan. Avoid continuous health polling or idle connections that
would defeat an intentionally enabled sleeping policy. Production availability
and cold-start behavior must be verified before enabling sleep on its app.

[Convex](https://www.convex.dev/pricing) has free resource allowances. Confirm the
team's actual plan and aggregate usage when creating the separate deployment.
[UploadThing](https://uploadthing.com/) lists 2 GB free storage shared across apps;
a separate production app isolates credentials/files but adds no free allowance.
The 500 MB account quota is not a global provider cap. Monitor aggregate storage,
including staging and failed-upload cleanup, before adding more friends. Do not
activate paid provider plans or silently change workspace-wide hard spending limits.

Rename Railway display labels only if needed for clear environment selection.
Repository renaming is deferred; it would require a separate automation/source
migration. Internal package names, data paths, environment variables and skill
folder names remain compatible.

## Private storage options for a later implementation PR

Payment is not the deciding factor for privacy. The read path must enforce the
intended access policy. The current UploadThing URLs remain public during testing,
and alpha copy should say so. Paying a provider does not by itself protect old URLs.

| Option | Free allowance checked on 2026-10-01 | Access design | Tradeoff |
| --- | --- | --- | --- |
| Convex file storage | 1 GB files and 1 GB data egress included on the pricing page | Authenticated HTTP action checks document ownership and returns bytes; do not expose `storage.getUrl` | Uses the existing backend account; HTTP action responses have a 20 MB limit |
| Cloudflare R2 Standard | 10 GB-month storage, 1 million Class A operations, 10 million Class B operations per month; direct R2 egress is free | Keep public bucket access disabled; use a server proxy or short-lived signed URLs after checking document access | More configuration and provider code; free allowances are limits, with usage beyond them billed |

Sources: [Convex pricing](https://www.convex.dev/pricing),
[Convex file serving and security](https://docs.convex.dev/file-storage/serve-files),
[R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[R2 private/public access](https://developers.cloudflare.com/r2/buckets/public-buckets/),
and [R2 signed URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/).

I would start with Convex authenticated file serving for a small private alpha.
The existing cloud upload limit is 8 MB per HTML file, below its 20 MB response
limit. Choose R2 if asset bundles or download volume make Convex's limits a poor
fit. Confirm account billing requirements and usage limits before enabling either.

The current storage adapter returns a read URL and supports deletion. It does not
implement Convex or R2 uploads. A migration PR must change upload, read, cleanup,
and schema validation together, keep legacy UploadThing records readable, and
verify cross-user access rejection. For strict access checks on each request,
serve bytes through an authenticated proxy. Signed URLs grant bearer access until
expiry and must not be described as requiring sign-in on each read.

Keep generated HTML sandboxed when serving private bytes. Review authorization
on both preview and raw file routes and ensure generated HTML cannot read app
cookies. Do not claim that existing public documents become private during a
provider switch. Copy or re-upload them, verify the replacement, delete the old
public object, and then update metadata. Only advertise private storage after
that implementation and the migration checks pass.

## Accepted decisions and remaining setup

- Public UploadThing storage is accepted for this small alpha. Private storage
  implementation is deferred; the public-file limitation must remain explicit.
- Keep generated Railway origins. No domain purchase is needed for this alpha.
- Set up production for friends while staging remains the development environment.
- Stay within Railway Hobby and the smallest practical setup. Report costs first;
  paid provider upgrades require a new decision.
- Separate production OAuth credentials and the UploadThing app must be created
  or supplied through their providers. Verify both before calling production ready.
- Optional revisions, unlisted sharing, and supported self-hosting remain on hold.
  Cloud artifact bundles in PR #133 are the next approved feature.

## Prepared production resources, not deployed

Railway production environment `e1aea48c-52b6-4103-ad64-3908e9274101` contains
empty app and site placeholders. Neither has a source or running deployment.
Staging remains unchanged.

- App service `plansplease-app-alpha`, ID `1cb3cb4e-3a14-4363-a4a6-99e9eb2da15d`.
- Reserved app origin `https://plansplease-app-alpha-production.up.railway.app`.
- Site service `plansplease-site-alpha`, ID `8b39c22b-5597-4d06-b186-45b4fe3f64e2`.
- Docs service creation was rejected by Railway's free-plan resource limit.
  The second environment already exists; the limit is on provisioned resources,
  not on creating a second environment. Activate Hobby before completing this
  three-service production setup, or review a lower-service-count alternative.

The production GitHub OAuth application should use the reserved app origin as its
homepage and this exact callback:

```text
https://plansplease-app-alpha-production.up.railway.app/api/auth/callback/github
```

Create a separate UploadThing app and Convex deployment when resuming. Save provider
secrets directly to production through provider/CLI inputs; do not paste them in
chat or commit them. No production backend, OAuth registration, storage app,
source connection, or running service has been created. Empty Railway placeholders
do not make the alpha ready for friends.
