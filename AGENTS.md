# plansplease (planview) — agent brief
TypeScript ESM monorepo for previewing HTML locally and saving pages and artifact folders in an account-based alpha cloud workspace. Written for coding agents working in this repository.

## The Project
Core promise: `plansplease publish <file|folder>` turns HTML into a durable, immutable localhost URL served by a private daemon, and the CLI uploads pages or artifact folders to the account-based alpha cloud workspace.
Non-goals: no production cloud domain yet; npm publishing stays disabled by default; `@planview/core` performs no filesystem, network, or cloud I/O; the app, marketing site, and docs app do not share a runtime.
Status: live.

## How I Work Here
- Quality gate: `verify` — `npm run verify` runs `release-policy` → `format:check` → `lint` → `typecheck` → `test` → `build`. Run before handoff.
- Commits: Conventional Commits (types are not machine-validated — no commitlint config exists). Squash merges; never commit to main.
- Node 24.19.0 and npm 11.16.0 are pinned (`.node-version`, `package.json` engines); install with `npm ci`.
- Hard rule — module boundary: `@planview/core` resolves conventional per-user paths and holds shared document invariants, but performs no filesystem, network, or cloud I/O. Keep that work in the owning adapter (`packages/local`, `packages/daemon`, `packages/storage`, `apps/app`), and keep Core's narrow Node defaults injectable.
- Cross-workspace dependencies are declared by package name and enforced by `scripts/workspace-boundary.mjs`, which holds the allowed dependency edges between workspaces.
- User-facing CLI changes need a patch Changeset (`npm run changeset`). Only patch bumps are allowed pre-1.0.0; `npm run release-policy` (part of `verify`) rejects minor/major CLI Changesets.
- Do not enable npm publishing or add registry credentials in a feature change.
- Effect v4 is used in `packages/daemon`, `packages/storage`, `packages/local`, and `apps/cli`: translate thrown or rejected failures into typed errors where they enter orchestration, and use scopes for resources that must be released.
- The published package name (`@abijith-suresh/planview`), its directory (`apps/cli`), and its binary (`plansplease`) intentionally differ; keep all three.
- Files under `apps/docs/src/content/` are product documentation content; the dated labels there are deliberate.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| Commit rules | repository history + .github/workflows/release.yml (no commitlint config in repo) |
Code and tests are the authority; this file never overrides executable truth.

## Getting Around
- `apps/cli` — public `@abijith-suresh/planview` package; the `plansplease` command and the bundled daemon.
- `apps/app` — authenticated SolidStart cloud workspace and MCP endpoint (Convex, Better Auth, UploadThing).
- `apps/site` — private static Astro marketing site (staging on Railway).
- `apps/docs` — private Astro + Starlight documentation app.
- `packages/core` — shared path, v1 policy, document-identifier, source-validation, and cloud-bundle-format primitives.
- `packages/daemon` — detached loopback-only lifecycle daemon and authenticated management boundary.
- `packages/storage` — daemon-private SQLite metadata and immutable document-file staging/finalization.
- `packages/local` — reusable local application API used by the CLI.
- `scripts` — repo tooling (release policy, changeset presence, workspace boundary, brand assets); its `*.test.mjs` suites run in `npm test`.
