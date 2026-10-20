# apps/cli — agent brief

The only published workspace: `@abijith-suresh/planview`, shipping the `plansplease` binary.

## The Project
Core promise: the CLI is the primary way to turn a local artifact into a durable preview URL, locally or through the cloud workspace.
Non-goals: no filesystem, network, or cloud I/O in `@planview/core`; that belongs to the adapters.

The directory (`apps/cli`), package name (`@abijith-suresh/planview`), and binary (`plansplease`) differ on purpose. Never rename one to match the others.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | root AGENTS.md § The Project |
| Runtime behavior | `src/` + `test/` |
| Commands & deps | package.json |
| How to work here | root `CONTRIBUTING.md` |
