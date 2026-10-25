# @abijith-suresh/planview

## 0.1.8

### Patch Changes

- 2e32dc8: Add the repository agent brief (`AGENTS.md`) so contributors and coding agents start from the repo's real conventions.
- c0703a1: Add a reusable, light and dark HTML document starter to the bundled create-html skill.
- e6e960c: Use the Vercel Skills CLI to install Planview's bundled Agent Skills.
- 0414f92: Upload artifact folders to the cloud, preserving relative CSS and JavaScript alongside HTML. Hosted MCP can upload, list, and read artifact files.
- 67b0646: Use the workspace sign-in entrypoint for CLI authorization so local workspaces can use development accounts while hosted workspaces keep GitHub sign-in.
- 47ed532: Simplify publication, output handling, and daemon cleanup while preserving existing formats and recovery behavior. Reorganize the CLI reference around local previews, cloud uploads, profiles, and automation.
- 4aa5373: Clarify CLI account sign-in and remote logout behavior in help and man pages.
- 0c5c29f: Use the shared cloud upload policy and support npm 12 pack output when building the CLI package.
- 4586390: Update the CLI's Effect runtime to the latest stable patch release.

## 0.1.7

### Patch Changes

- ed186cf: Enforce the cloud account storage quota before uploads and retain capacity for pending cleanup.
- 476480e: Update the bundled Planview skill for folder previews, cloud uploads, hosted MCP, and current access and retention limits.
- 024e5f6: Render cloud-uploaded HTML directly from storage in a sandboxed browser preview, including older files delivered as attachments.
- 4703968: Upgrade the CLI and local document runtime to the stable Effect 4.0 release.
- 485be24: Rename the CLI executable from planview to plansplease. Update scripts to invoke plansplease; the previous command is no longer installed. Help, version output, the manual and agent examples use the plansplease name. Existing profiles, documents, credentials, daemon state and installed skills retain their locations, and the npm package and PLANVIEW\_\* settings keep their names.
- 9ee4d81: Use the plansplease staging hostname for cloud login and migrate saved credentials from the previous staging hostname when uploading, replacing, or revoking them. Custom cloud origins remain unchanged.
- b28590c: Keep the CLI signed in with an upload-only cloud credential and revoke it on logout.

## 0.1.6

### Patch Changes

- 89b514d: Consolidate TypeScript project settings used to build the CLI.
- f7bb15b: Separate document file contracts from the filesystem implementation.
- ec82c7f: Reuse sorted physical document IDs across pages in one file scan.
- 89ba306: Separate CLI argument parsing from command execution.
- 8a05b04: Resume bounded cleanup in physical file reconciliation when metadata reconciliation finishes exactly at the item budget.
- a3fe7f4: Separate daemon configuration and path resolution from lifecycle operations.
- b618780: Move daemon request concurrency gates into focused, directly tested modules.
- 421b078: Move daemon HTTP route handling into an internal module.
- dcead40: Use a patched esbuild version for CLI bundling.
- 0e40442: Isolate the daemon HTTP transport lifecycle behind an internal boundary.
- 80df858: Separate publication contracts from the coordinator implementation.
- e542ae8: Move CLI command errors and output formatting helpers behind an internal module.
- 390e54a: Move local CLI command handlers into an internal module.
- 9974b3d: Add browser based cloud login and standalone HTML uploads to the CLI.
- d5ddcf9: Move metadata store contracts behind a focused storage boundary.
- c2bd0a7: Bound cloud uploads to five minutes, including the response body.
- 1977cea: Extract staged document file finalization lock recovery into a private storage module.
- 79e6797: Update the Effect v4 runtime to rc.117 across the workspace packages.
- 0ad309b: Remove unused storage coordinator aliases from the internal package API.
- 0eb8903: Bound cloud upload reads and cover the local sign-in and upload protocol.
- 149c5c2: Separate SQLite schema validation and migrations from metadata operations.
- 91e4499: Tie daemon storage resources to an Effect scope.
- ef5dbc5: Refactor the published document reader while preserving the CLI behavior.
- 67f9bc6: Keep the SQLite metadata implementation behind the existing storage package entry point.
- 549822c: Share macOS system path alias handling between the CLI and storage layers.

## 0.1.5

### Patch Changes

- da01ecf: Expose named local profiles through the CLI and keep document URLs tied to the selected profile.
- b9a6bbf: Use the next available loopback port when the preferred Planview daemon port is occupied.
- c9b18f1: Give named local profiles isolated Planview state and daemon identity.

## 0.1.4

### Patch Changes

- 0dc132c: Add command-specific help, strict option parsing, and JSON output for CLI metadata commands.
- a2928c0: Keep CLI command composition in Effect and clean prepared sources after failed publications.
- af7ce8c: Route CLI operations through the reusable local Effect API.
- ba8743b: Document CLI usage and package a Unix man page.
- 51466a4: Improve publish guidance and the missing-input message.
- 1bc8657: Expose daemon lifecycle and document operations as typed Effect programs.
- 1bc8657: Upgrade the CLI runtime to the current Effect v4 release candidate.
- 4437bb4: Expose publication and cleanup coordination as typed Effect programs.
- 7519d6d: Align Effect v4 boundaries with typed errors and propagate cancellation through daemon operations.

## 0.1.3

### Patch Changes

- dc770c3: Support publishing a page folder as one immutable bundle and serving its root page and assets.
- 83ea311: Typecheck CLI tests with Node TypeScript.
- 2c3b84c: Typecheck core package tests with Node TypeScript.
- adc3486: Keep local publishing and bundled skill installation working with native macOS and Windows paths.
- 3ed3dbf: Typecheck daemon package tests with Node TypeScript.
- b9e2f70: Add a `preview` command that publishes a file or page folder and opens its URL in the default browser.
- dc6d2b5: Harden detached daemon environment handling, request cancellation, and source-file staging.
- 26501b7: Reject daemon descriptor and lifecycle-lock reads when the opened file is not the file that was observed.
- 09ab8ea: Typecheck storage package tests with Node TypeScript.
- 2bc3a86: Discover repository tests from their workspace globs.

## 0.1.2

### Patch Changes

- 79c59a3: Add `planview get` for streaming immutable snapshots by document id or exact local URL.
- 8d11eee: Add a fixed v1 storage quota that rejects publications safely when retained snapshots would exceed the logical 1 GiB limit.
- 3942f49: Add authenticated 30-day snapshot cleanup, startup reconciliation, and automatic daemon retention maintenance.
- cbdcc02: Harden detached daemon startup and cleanup recovery, keep private workspace details out of the public declaration, and clarify local snapshot retention behavior.
- 8c42285: Add bundled `planview` and `create-html` Agent Skills with a safe
  `planview skills install` command.
- 42fc383: Bound daemon shutdown across in-flight publication and cleanup operations, cancel request pipelines safely, and retain atomic publication recovery and descriptor cleanup.
- 5ed1708: Batch snapshot cleanup with indexed, resumable retention candidates and bounded reconciliation work.
- 79ba794: Allow stalled snapshot downloads to be aborted and bounded without blocking unrelated publish and cleanup operations; retain read protection through post-transfer access tracking.

## 0.1.1

### Patch Changes

- a3adeea: Integrate the pinned Effect 4 beta runtime at the CLI execution boundary while preserving existing help, version, and argument-error behavior.
- a3adeea: Add the initial installable CLI bootstrap with deterministic help and version output.
- 073e81b: Add `start`, `status`, `stop`, and `restart` commands for the private localhost daemon lifecycle.
- b29efcc: Add `publish <file>` to store immutable HTML snapshots and serve them from authenticated daemon-managed localhost URLs.
