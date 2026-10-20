# Contributing

## Working agreements

- Branch, open one PR against `main`, and leave it for the owner. Never commit or push to `main`; never merge your own PR.
- Conventional Commits; squash merge.
- Run `npm run verify` before handoff. Add focused tests for the behavior you touched — CI owns the full suite.
- Changes touching the published CLI need a patch Changeset; no minor or major bumps before 1.0.0.
- Editing a workspace's dependencies means updating the allow-list in `scripts/workspace-boundary.mjs`; the boundary check fails otherwise.
- Don't add registry credentials or publishing switches in a feature change.
- Every change under `apps/cli/**` trips CI's Changeset gate, even documentation-only ones.

## Changesets

User-facing changes to the public `@abijith-suresh/planview` package need a
Changeset. Run `npm run changeset`, select `@abijith-suresh/planview`, and choose
`patch`. Until the package reaches `1.0.0`, Planview uses patch-only releases. The automated
`npm run release-policy` check enforces that rule for pending Changesets; it
ignores Changesets' README/config files and entries for other (including
private) packages.

Keep the published package name as `@abijith-suresh/planview` (`apps/cli/package.json`);
the CLI binary is `plansplease`,
and the private workspace is named
`planview-workspace`.

## Effect v4 and module boundaries

**Trap:** `@planview/core` performs no filesystem, network, or cloud I/O. It resolves paths and holds shared document policy; every side effect belongs to the owning adapter.

- Keep shared local-document invariants and types in `@planview/core`; keep
  app-specific authorization, routing, and cloud policy in their owning
  workspace until a shared boundary is justified. The cloud bundle format and
  MIME/path policy are pure shared Core modules used by app validation and CLI
  prevalidation. App and CLI declare that Core dependency; neither imports the
  other application. Core currently has narrow
  Node-backed defaults: `node:crypto` for document ID randomness and
  `node:os`/`node:path`, `process.platform`, `process.env`, and `homedir()` for
  app-data path resolution. Keep these defaults limited and injectable, and
  pass explicit inputs when callers need deterministic behavior. Core resolves
  paths but does not perform filesystem, network, or cloud I/O; keep that work
  in the owning adapters.
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

The repository does not publish the package to npm yet. npm publishing remains
disabled by default. Before `1.0.0`, only patch Changesets are allowed.

A maintainer decides when the package is ready for a public release. They review
the generated release pull request and explicitly enable publishing credentials.
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
paths in leaf configs. Run `npm run verify` before review.

Before opening a change, run:

```sh
npm ci
npm run verify
npm run changeset:status
npm run pack:check
```

The same release-policy check runs before
`npm run version-packages` and `npm run release`, so a pre-1.0.0 minor or major
`@abijith-suresh/planview` Changeset cannot be versioned or published accidentally.

Changesets are versioned and published by maintainers. The release workflow
creates or updates `changeset-release/main`, but it does not publish while npm
publishing is disabled.
