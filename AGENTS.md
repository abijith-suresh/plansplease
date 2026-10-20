# planview — agent brief

planview is a TypeScript ESM monorepo for turning HTML files and artifact folders into durable previews: the `plansplease` CLI serves immutable snapshots from a local daemon and can upload the same artifacts to an account-based alpha cloud workspace. It carries the CLI, the authenticated cloud app and MCP endpoint, a marketing site, a docs site, and the shared packages behind them.

## The Project
Core promise: one command turns an HTML file or folder into a durable, immutable URL, and the same artifact can be shared through the cloud workspace.
Non-goals: a production cloud domain, public npm publishing before the owner enables it, and any filesystem, network, or cloud I/O in Core. `@planview/core` resolves paths and holds shared document policy; adapters (`local`, `daemon`, `storage`, `app`) own all I/O.
Status: live, alpha.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| How to work here | `CONTRIBUTING.md` |
| Release policy | `CONTRIBUTING.md` + scripts/release-policy.mjs |
| Package intent | `apps/cli/AGENTS.md` |

Code and tests are the authority; this file never overrides executable truth.
