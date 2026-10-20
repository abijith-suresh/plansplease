# apps/cli — agent brief

The only published workspace: `@abijith-suresh/planview`, shipping the `plansplease` binary.

## How I Work Here
- The directory (`apps/cli`), package name (`@abijith-suresh/planview`), and binary (`plansplease`) differ on purpose. Never rename one to match the others.
- Every change under `apps/cli/**` trips CI's Changeset gate, even documentation-only ones.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | root AGENTS.md § The Project |
| Runtime behavior | `src/` + `test/` |
| Commands & deps | package.json |
| Commit rules | root AGENTS.md |
