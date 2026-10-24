# plansplease

plansplease is a TypeScript ESM monorepo for previewing HTML locally and saving pages and artifact folders in an
account-based alpha cloud workspace. Cloud file URLs are public during testing. The CLI command is `plansplease`;
existing `planview` scripts need updating. Profiles, documents, credentials and daemon
state retain their locations. Package names,
local data paths, `PLANVIEW_*` settings and installed skill directories remain compatible.

## Full local workspace

After `npm ci`, run `npm run local`. Open http://127.0.0.1:3000 and create a local
test account. The command runs the real app, anonymous local Convex backend,
filesystem document storage, marketing site, and docs without paid hosting or
provider accounts. Data survives Ctrl-C and restart.

See [the local development guide](apps/docs/src/content/docs/reference/development.mdx#full-local-workspace) for browser uploads, CLI
login/upload/logout, authenticated MCP, source watching, and explicit reset.
Existing `.env.local` files and hosted deployments are left alone.

## Bootstrap status

The foundation includes the public `@abijith-suresh/planview` npm workspace and the
private `@planview/core`, `@planview/daemon`, `@planview/storage`, and
`@planview/local` workspaces. The CLI
is an installable TypeScript ESM package with detached daemon lifecycle
commands: `start`, `status`, `stop`, and `restart`, plus `publish <file|folder>`
and `get <id|url>` for immutable HTML snapshots. `publish --open <file|folder>`
opens the resulting URL after publishing. A publish folder must contain
`index.html`; its assets are served below the same immutable URL. The private daemon is bundled into
the one published CLI artifact and owns loopback-only lifecycle HTTP and direct
snapshot serving.
See [apps/cli/README.md](apps/cli/README.md) for CLI usage and automation details.
Core resolves conventional per-user application-data paths and holds the fixed
v1 policy values. Storage owns daemon-private metadata in a versioned SQLite
database, immutable document-file staging/finalization, and a private
publication coordinator. It does not publish URLs, run cleanup policy, or
expose document/HTTP behavior. The private `apps/site` workspace is a static
project site, kept separate from the local daemon and application UI.

## Prerequisites

Use Node.js 24.19.0 and npm 11.16.0 (the versions declared by the repository
configuration). Install the locked dependencies with:

```sh
npm ci
```

Run the complete foundation check with:

```sh
npm run verify
```

The root verification runs formatting, linting, workspace typechecks, the
foundation smoke test, the CLI's built-in tests, storage's hermetic SQLite
integration tests, and workspace builds. The CLI package can also be checked
directly:

```sh
npm run typecheck --workspace @abijith-suresh/planview
npm test --workspace @abijith-suresh/planview
npm pack --dry-run --workspace @abijith-suresh/planview
```

The package dry run invokes the CLI's `prepack` build, so it does not depend on
an existing ignored `dist` directory. Workspace checks and builds run each
package's matching script when present.

## Documentation

The private `apps/docs` workspace is a separate Astro + Starlight application.
It contains current CLI/MCP guides, architecture, privacy/limits, troubleshooting,
and dated labels for features that are merged but not deployed or still proposed.
See [apps/docs/README.md](apps/docs/README.md) for development and static deployment.
Marketing `/docs/`, `/cli/`, and `/mcp/` keep legacy entry pages and link to the
canonical docs service. `PUBLIC_DOCS_URL` configures those marketing links.

## Marketing site

Build or smoke-test the private Astro site with:

```sh
npm run build --workspace @planview/site
npm test --workspace @planview/site
```

`BASE_PATH` sets an optional deployment prefix. Leading and trailing slashes are
normalized, for example `BASE_PATH=/plansplease npm run build --workspace
@planview/site`. It is normally unset because the site is deployed at the root of
its Railway domain.

The marketing site is currently branded as plansplease and runs in the staging environment on
Railway. It is available at
[`plansplease-site-staging.up.railway.app`](https://plansplease-site-staging.up.railway.app)
in the `planview-cloud` project. The staging app is available at
[`plansplease-app-staging.up.railway.app`](https://plansplease-app-staging.up.railway.app).
There is no production marketing service or custom domain yet.

The marketing staging service uses this configuration:

- build: `npm run build --workspace @planview/site`
- start: `npm start --workspace @planview/site`
- health check: `/health`

The cloud app will get a production domain after the product domain is purchased and configured.

CI runs the required Node 24 quality gate on Linux for pull requests and pushes to
`main`. Its smoke check uses the Vercel Skills CLI to install skills from the
checkout into an isolated project. It also packs the public
`@abijith-suresh/planview` npm package and smoke-tests the resulting tarball
without publishing it or requiring a secret. macOS and Windows run the packed
CLI lifecycle smoke for publish/get and daemon status/stop; the POSIX-only
storage suite remains part of Linux `npm run verify`. A push to `main` validates the
repository, then the Changesets Action creates or updates the generated
`changeset-release/main` version PR with the `RELEASE_TOKEN` PAT. Merging that PR
runs the same release command. npm publishing is disabled by default. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the release policy.

Railway builds the site from the monorepo root so it can use the repository
lockfile. The marketing services do not share a runtime with the SolidStart app.
`server.mjs` serves the generated Astro output and exposes the health endpoint.
Vercel is not used for the marketing site.

## Security follow-up

`npm audit` on the checked-in lockfile reports five high-severity package names:
`astro@7.3.5`, `unstorage@1.17.5`, `uploadthing@7.7.4`,
`@uploadthing/shared@7.1.10`, and `effect@3.17.7`. Astro 7.3.5 removes the
prior critical AVIF advisory and the affected esbuild and sharp versions.
Astro and unstorage remain in npm's report because unstorage declares an
optional UploadThing peer dependency. Astro builds the static `apps/site`; it
does not run in the SolidStart app's runtime.

The app uses UploadThing's server-side `UTApi`. Its
dependency tree contains Effect `3.17.7`, separate from the repository's Effect
v4 dependency. The [Effect advisory](https://github.com/advisories/GHSA-38f7-945m-qr2g)
describes `AsyncLocalStorage` context loss or contamination in Effect fibers
under concurrent load when RPC is involved. The lockfile confirms the affected
version is present, but does not show that this app exercises that RPC path.
UploadThing pins Effect `3.17.7`. An attempted npm override to a patched Effect
version resolved the repository's incompatible Effect v4 copy for UploadThing,
so it was not retained. npm suggests downgrading UploadThing to `6.12.0`; that
version predates the current server upload API and needs a separate compatibility
review. The remaining five names stay open until UploadThing updates its pin or
the provider is changed.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for changeset, verification, and release
policy requirements.

## Planned structure

- `apps/cli` — public npm package (`@abijith-suresh/planview`), with the `plansplease` command
- `apps/site` — private static project site
- `apps/docs` — private static Starlight documentation app
- `apps/app` — authenticated SolidStart cloud workspace and MCP endpoint
- `packages/core` — private path, v1 policy, document identifier, and source-file validation primitives
- `packages/daemon` — private detached lifecycle daemon and authenticated management boundary
- `packages/storage` — private daemon-owned metadata and document-file storage boundary
- `packages/local` — reusable local application API used by the CLI and future MCP adapter
- `packages/*` — reusable implementation packages

SQLite-backed publication and CLI retrieval are implemented. The daemon performs
startup reconciliation and authenticated 30-day last-access cleanup at startup and
every 24 hours; `plansplease clean` invokes the same policy.
