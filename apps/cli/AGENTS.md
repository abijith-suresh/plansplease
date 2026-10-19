# plansplease CLI — agent brief
The public `@abijith-suresh/planview` package that ships the `plansplease` command. Package-specific notes only; the root AGENTS.md rules apply here too.

## The Project
Core promise: publish immutable localhost HTML snapshots through the private daemon, and upload pages or artifact folders to the alpha cloud workspace.
Non-goals: this package owns no filesystem, network, or cloud policy; it wires commands to `@planview/local`, `@planview/daemon`, and `@planview/storage`.
Status: live.

## How I Work Here
- No package-local verify script; run the root `npm run verify`.
- `npm run build` runs `tsc`, bundles with `scripts/bundle.mjs` (esbuild), then marks `dist/index.js` executable. `prepack` builds, so `npm pack` needs no prebuilt `dist`.
- The directory (`apps/cli`), package name (`@abijith-suresh/planview`), and binary (`plansplease`) intentionally differ; do not "fix" them.
- `npm test` builds first, typechecks the test project, then runs `node --test "test/**/*.test.mts"`.
- User-facing changes need a patch Changeset; CI's `scripts/changeset-presence.mjs` requires one for releasable CLI paths.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | root AGENTS.md § The Project |
| Runtime behavior | `src/` + `test/` |
| Commands & deps | package.json |
| Commit rules | root AGENTS.md |

## Getting Around
- `src/index.ts` — CLI entry point.
- `src/arguments.ts`, `src/help.ts`, `src/output.ts` — argument parsing, help text, and JSON output.
- `src/commands/` — command implementations.
- `src/cloud.ts`, `src/cloud-file.ts` — cloud sign-in and upload transport.
- `scripts/` — bundle and executable-bit steps.
- `man/` — Unix man page shipped with the package.
