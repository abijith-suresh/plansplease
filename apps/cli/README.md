# plansplease CLI

`@abijith-suresh/planview` installs the `plansplease` command. It publishes
immutable local snapshots and uploads HTML files or artifact folders to an
account workspace. The package is not published to npm yet.

## Install

Use Node.js 24.19.0 and npm 11.16.0:

```sh
git clone https://github.com/abijith-suresh/plansplease.git
cd plansplease
npm ci
npm pack --workspace @abijith-suresh/planview --pack-destination .
```

Replace `FILE.tgz` with the filename printed by `npm pack`:

```sh
npm install --global --ignore-scripts ./FILE.tgz
plansplease --version
```

Use `plansplease help` or `plansplease help <command>` for command options.
The package also includes a Unix manual page. Some npm versions register it
with `man plansplease`; others leave it in the installed package.

## Local snapshots

```sh
plansplease publish --open ./report.html
plansplease publish --open ./site/
plansplease get <id-or-exact-local-url> > recovered.html
```

`publish` accepts a regular `.html` or `.htm` file, or a folder with root
`index.html` and up to 512 files. The encoded snapshot, including a folder's
manifest, must fit within 10 MiB. Symlinks and changing folders are rejected.
Editing the source does not change a snapshot. Publish again for a new URL.

The detached daemon binds to `127.0.0.1:4777` or the next available port within
50 ports. Use the exact URL printed by `publish`. A folder's root URL redirects
to `index.html`; its assets are available below `/<id>/`.

`get` writes the stored HTML bytes to stdout. It accepts an ID or an exact local
URL for the selected profile's current port. It does not read cloud documents
or follow a folder-root redirect; open artifact folders in a browser.

```sh
plansplease start
plansplease status
plansplease stop
plansplease restart
plansplease clean
```

`status` does not start the daemon or create runtime state. `start` reuses an
authenticated daemon it owns and never terminates an unknown process on the port.
`clean` starts or reuses the daemon, removes snapshots last accessed more than
30 days ago, and reconciles incomplete storage operations. Cleanup also runs
at startup and every 24 hours.


## Inventory and selected deletion

```sh
plansplease list --limit 50 --json
plansplease list --after <nextAfter> --limit 50 --json
plansplease usage --json
plansplease delete <id> --generation <generation-from-list> --json
```

These commands start or reuse the selected profile's daemon, including startup
cleanup. After updating the installed CLI, restart the selected profile daemon
to load its new operations. Inventory reads at most 100 metadata rows per page, ordered by ID.
`nextAfter` is omitted on the final page. Pages reflect current metadata, so a
concurrent publication before the cursor appears on a fresh traversal. Listing
and usage never extend retention. Each row includes `createdAt`, `lastAccessedAt`,
`size`, immutable `generation`, and `expiresAt` as epoch milliseconds. Expiry is
30 days after last access; cleanup removes rows strictly older than that boundary.
A successful document read can move expiry later.

`usage` reports logical committed bytes, split into document bytes and a fixed
4 KiB metadata charge per snapshot, plus the 1 GiB quota and retention period.
It does not measure physical disk use, SQLite allocation, staging, or orphan files.

Deletion requires the ID and generation from inventory. It never deletes cloud
copies. An active read retains both the metadata and file; retry after the read
finishes. A stale selection returns `stale`; list again before selecting a new
generation. Deletion can also return `deleted`, `not_found`, `retained`, or
`partial`. Only `deleted` and `not_found` exit with status 0. Removal flags describe
confirmed changes; `fileState` can be `unknown` after a storage failure.

A failure after metadata removal can leave an invisible orphan file. The result
reports `partial` and `recovery: "clean"`; run `plansplease clean` to resume the
existing bounded reconciliation. Fresh orphan files stay until the recovery grace
period passes. Reconciliation also runs after daemon restart. A metadata commit
whose acknowledgement fails is partial unless a read proves the selected
generation is still retained; then retry the selection. `recovery: "inspect"`
means the metadata state could not be established; list again before choosing
any retry. No automatic retry or cloud deletion occurs. If a response is lost, list again and use cleanup
for residual storage; never substitute a different generation in a blind retry.

## Cloud uploads

Hosted services are currently offline; see the
[features reference](../docs/src/content/docs/reference/planned-features.md).
For testing, start the [local workspace](../docs/src/content/docs/reference/development.mdx#full-local-workspace),
then run:

```sh
plansplease login --cloud-url http://127.0.0.1:3000
plansplease upload --open ./report.html
plansplease upload --json ./artifact/
plansplease logout
```

Login opens a browser for account sign-in and CLI authorization. The local
workspace uses a test account; the hosted configuration uses GitHub. Pass
`--cloud-url <origin>` to login or set `PLANVIEW_CLOUD_URL` to select another
app. Upload and logout use the destination saved at login.

The credential permits uploads only and stays valid until revoked. Logout
revokes it before removing the local file, so it requires a connection. Use MCP
or the workspace to list and read cloud documents.

Upload accepts one standalone `.html` file or an artifact folder with root
`index.html`. A bundle can contain up to 512 files and must fit within 8 MiB,
including its manifest. Supported assets include HTML, CSS, JavaScript, modules,
JSON, text, SVG, common images, fonts, and MP4/WebM. Paths use ASCII letters,
digits, dots, underscores, hyphens, and `/` folders. The complete encoded object
counts against the account quota.

The returned workspace URL requires the owning account to sign in. Relative
stylesheets, scripts, and module imports resolve within the artifact. Bundle
previews issue a five-minute read capability; reopen the workspace URL when it
expires. UploadThing object URLs are public during alpha. Use non-sensitive
content.

## Profiles and local storage

```sh
plansplease --profile work publish ./report.html
```

Profiles isolate local documents, daemon state, and saved cloud credentials.
The default profile keeps the existing Planview data location; named profiles
live below `planview/profiles/<name>`. Environment settings retain their
`PLANVIEW_*` names.

On POSIX, app-data and runtime directories are owned by the current UID and
restricted to `0700`. Credentials, descriptors, and lock files use `0600`.
Windows users must provide an account-owned app-data directory that other users
cannot write. Node does not provide portable APIs to enforce NTFS ACLs or
classify every reparse point. The daemon's loopback binding and authenticated
requests do not provide filesystem isolation against a hostile local user.

## Automation

Successful results go to stdout; errors go to stderr. Exit status `0` means
success and `1` means invalid input or an operation failure. `get` writes only
document bytes.

Global options precede the command. Command options can precede or follow
operands. `--` ends option parsing; unknown options fail before work starts.
Commands accepting `--json` emit one newline-terminated JSON value:

```sh
plansplease publish --json ./report.html
# {"id":"<id>","url":"http://localhost:4777/<id>"}
```

`status --json` returns `{"state":"stopped"}` or a running daemon's `profile`,
`host`, `port`, `pid`, and `startedAt`. `start --json` adds `reused`.
`stop --json` returns the stopped state. `clean --json` includes cleanup counts
and failure messages without internal causes. `--open` opens the returned URL
and preserves the normal command output.

## Agent skills

The package includes `planview` and `create-html` skills. Install them into your
project with the [Vercel Skills CLI](https://github.com/vercel-labs/skills):

```sh
npx skills add https://github.com/abijith-suresh/plansplease/tree/main/apps/cli/skills
```

From a plansplease checkout, use `npx skills add ./apps/cli/skills`. Add `-g` for
user-wide installation, `-a codex` to select Codex, and `-y` to skip prompts.
Rerun the command to replace existing copies.

The build bundles the private local-runtime packages into `dist`. The installed
CLI and its declarations do not depend on private `@planview/*` packages.
