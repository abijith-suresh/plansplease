# Contributing

## Working agreements

- Branch, open one PR against `main`, and leave it for the owner. Never commit or push to `main`; never merge your own PR.
- Conventional Commits; squash merge.
- Run the checks below before handoff. Add focused tests for behavior changes.
- Changes to shipped CLI files or its bundled runtime need a patch Changeset, including CLI documentation-only changes. `scripts/changeset-presence.mjs` defines the checked paths.
- Keep cross-workspace dependencies consistent with the allow-list in `scripts/workspace-boundary.mjs`.

## Changesets

Run `npm run changeset`, select `@abijith-suresh/planview`, and choose `patch`.
Until `1.0.0`, `npm run release-policy` rejects minor and major Changesets for
that package. The check also runs before versioning and release.

Keep the published package name as `@abijith-suresh/planview` (`apps/cli/package.json`);
the CLI binary is `plansplease`, and the private root workspace is
`planview-workspace`.

## Effect v4 and module boundaries

- Keep shared local-document invariants and types in `@planview/core`; keep
  app-specific authorization, routing, and cloud policy in their owning
  workspace until a shared boundary is justified. The cloud bundle format and
  MIME/path policy are pure shared Core modules used by app validation and CLI
  prevalidation. App and CLI declare that Core dependency; neither imports the
  other application. Core uses `node:crypto` for document ID randomness and
  `node:os`/`node:path`, `process.platform`, `process.env`, and `homedir()` for
  app-data path resolution. Keep these defaults injectable for deterministic
  callers. Core performs no filesystem, network, or cloud I/O; adapters own
  that work.
- In workspaces that use Effect, translate thrown or rejected failures into
  explicit error types where they enter orchestration, and compose fallible
  async work as typed Effects.
- In Effect-using operations, use scopes and resource combinators when an
  operation owns resources that must be released on success, failure, or
  interruption. Keep pure data transformations as ordinary functions.
- Use `Context.Service` and `Layer` when a capability is shared across modules
  or its implementation has a meaningful dependency graph or lifecycle. Do not
  add a service for every helper: explicit constructor or function parameters
  are appropriate when they make a small dependency set easier to follow.

See Effect's [service](https://effect.website/docs/v4/requirements-management/services),
[layer](https://effect.website/docs/v4/requirements-management/layers), and
[resource management](https://effect.website/docs/v4/resource-management/introduction)
guides for the v4 APIs and their intended roles.

## Release policy

The release workflow creates or updates `changeset-release/main`. Maintainers
version the package and review that PR. npm publishing stays disabled until a
maintainer enables it.

Do not enable npm publishing or add registry credentials in a feature change.

## Workspace boundaries

`apps/` contains deployable applications and the public CLI. `packages/` contains
reusable implementation with explicit package boundaries. The static docs workspace
owns its Starlight content and server; it links to app/site origins without importing
another application's implementation. Keep code with its
application until another workspace needs it or a distinct build, test, or API
boundary justifies a package. Declare cross-workspace dependencies by package
name in the owning `package.json`; npm links configured workspaces during install.

For composite TypeScript libraries, record dependency edges in `references` and
add the project to the root solution `tsconfig.json`. Keep shared compiler
settings in the root TypeScript base configs, and keep source includes and output
paths in leaf configs.

The boundary check reads workspace manifests and literal imports, exports, and
module calls. It uses TypeScript for path aliases and Astro for component syntax.
Review computed imports and custom module loaders when adding them.

## Verification

Before opening a change, run:

```sh
npm ci
npm run verify
npm run changeset:status
npm run pack:check
```


## Installed manager browser checks

The local manager is built with the CLI's `build:manager` step. It uses stable
Solid and Vite to produce static assets under `apps/cli/dist/manager`; no dev
server is part of the installed runtime. UI TypeScript is checked separately
with `apps/cli/ui/tsconfig.json`.

Install the test browser once, then run the installed-package browser exercise:

```sh
npx playwright install chromium
npm run test:manager:browser
```

The script packs and installs into an isolated prefix with lifecycle scripts
disabled, uses an unrelated cwd, and tests the actual compiled UI in Chromium.
It covers independent sessions, Host/Origin isolation from a hostile preview,
exact-byte import, open/copy/delete, logout/reconnection and shutdown of both
listeners. Set `PLANVIEW_BROWSER_ARTIFACT_DIR` to save desktop/mobile screenshots;
with that option it also checks mobile horizontal overflow. CI passes its already
built `TARBALL` to the same script to reuse packaging verification. The existing
Windows/macOS packed smoke covers assets, native session exchange, import/delete,
process reuse and two-listener shutdown. Actual corporate-laptop browser policies
remain a separate manual check.

Do not run `cross-platform-smoke.mjs` concurrently with source tests: it clears
build outputs to verify a clean package build. Browser checks use no cloud token,
external document endpoint or hosted service.


The installed offline-retention exercise runs with `node scripts/offline-retention-smoke.mjs`
after building the CLI. `TARBALL` reuses an already verified package. It seeds an
isolated profile through storage APIs while the daemon is stopped, closes that
fixture owner, then exercises only the installed CLI/HTTP operations. The fixture
fills the real 1 GiB logical quota with matching sparse files and expired pins,
checks quota refusal for publication/import, restart, unpin expiry, explicit
delete, concurrent mutations and exact bundle bytes. The same exercise runs in
native Windows/macOS packed smoke and Linux packaging CI. It changes no runtime
quota, retention clock or shared settings.


Installed profile checks run with `node scripts/profile-controls-smoke.mjs`
after a CLI build; `TARBALL` can reuse a verified package. The same helper runs
inside native Windows/macOS packed smoke. It checks offline discovery/creation,
malformed and stale current-profile descriptors, same-ID byte/pin/receipt isolation,
independent ports and sessions, native-secret rejection, bounded profile counts
and symlinks/junctions. It measures daemon PID counts across planning, explicit
launch and independent shutdown. Its browser-launch observer intercepts the
installed CLI's platform launcher, so only `--open` records a launch and CI never
opens an unsolicited system browser. Windows profile ACL metadata checks use
short hidden PowerShell processes, with a five-second deadline and no persistent
helper. The helper omits inherited `PSModulePath` only from its child environment
so Windows PowerShell builds its own module paths when launched through Node from
PowerShell 7. The caller environment and ownership policy are unchanged. The
Chromium workflow exercises the actual two-profile manager flow,
including lazy discovery and copyable command selection with no authority transfer.
