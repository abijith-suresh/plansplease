# planview — agent brief

planview is a TypeScript ESM monorepo for turning HTML files and artifact folders into durable previews: the `plansplease` CLI serves immutable snapshots from a local daemon and can upload the same artifacts to an account-based alpha cloud workspace. It carries the CLI, the authenticated cloud app and MCP endpoint, a marketing site, a docs site, and the shared packages behind them.

## The Project
Core promise: one command turns an HTML file or folder into a durable, immutable URL, and the same artifact can be shared through the cloud workspace.
Non-goals: a production cloud domain, public npm publishing before the owner enables it, and any filesystem, network, or cloud I/O in Core.
Non-negotiables: `@planview/core` resolves paths and holds shared document policy but performs no I/O; adapters (`local`, `daemon`, `storage`, `app`) own all of it. Keep Core's narrow Node defaults injectable.
Status: live, alpha.

## How I Work Here
- Branch, open one PR against `main`, and leave it for the owner. Never commit or push to `main`; never merge your own PR.
- Conventional Commits; squash merge.
- `npm run verify` before handoff. Add focused tests for the behavior you touched — CI owns the full suite.
- Changes touching the published CLI need a patch Changeset; no minor or major bumps before 1.0.0.
- Editing a workspace's dependencies means updating the allow-list in `scripts/workspace-boundary.mjs`; the boundary check fails otherwise.
- Don't add registry credentials or publishing switches in a feature change.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| Commit rules | repository history + .github/workflows/release.yml |
| Release policy | CONTRIBUTING.md + scripts/release-policy.mjs |
Code and tests are the authority; this file never overrides executable truth.
