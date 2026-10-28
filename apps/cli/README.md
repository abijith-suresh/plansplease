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

## Local browser manager

```sh
plansplease ui
plansplease ui --open
plansplease --profile work ui
```

`ui` explicitly starts a manager listener in the selected profile's existing
Node daemon and prints a private, one-use launch link. It does not open a browser
unless `--open` is given. Publishing, help, version and status do not start the
manager. The compiled Solid/Vite HTML, CSS and JavaScript ship with the CLI;
there is no frontend dev server or second persistent Node process.

The manager uses a separate `127.0.0.1` port from HTML previews. Its launch code
is in the URL fragment, never a query string, and expires after one minute.
The page removes the fragment before making requests and exchanges it for an
independent browser session. Treat the launch link as private. Sessions last up
to eight hours and stay only in page memory: no cookies, localStorage or
sessionStorage authority. Reloading requires a fresh `plansplease ui` link.
Signing out revokes only that browser session; previews continue running.
At most eight unused launch codes and eight browser sessions can exist per
daemon. Wait for code expiry, sign out of another session, or restart the daemon
if a limit is reached.

Use the shelf to list snapshots, open them on their preview origin, copy links,
delete a selected immutable generation, inspect logical quota/retention, and
import one `.html` or `.htm` file up to 10 MiB. Import keeps the exact bytes and
uses the existing publication and quota operations. It cannot read an absolute
browser-supplied path, import a folder bundle, or execute artifact HTML on the
manager origin. Temporary source files are removed after each import attempt.
If an import response is lost, refresh inventory before selecting the file
again. Do not assume a failed response means publication did not commit.

Inventory is paged at 50 rows and does not extend retention. Preview reads can
extend the fixed 30-day last-access period. The 1 GiB quota includes committed
snapshot bytes plus 4 KiB per metadata row; it is not a physical disk-usage
measurement. Active readers may prevent selected deletion. Partial results
retain their existing cleanup/inspection guidance, including orphan recovery
grace. The manager shows the active profile and storage path; profile creation,
switching and policy controls remain a separate slice.

The manager remains available after the CLI exits. **Stop daemon & previews**,
`plansplease stop`, or a daemon shutdown stops both listeners. Stored snapshots
remain on disk under the existing retention policy. Starting again requires a
fresh launch link. After replacing an installation, restart its owned daemon
to load the new code and assets.

The manager validates the exact Host and Origin and authenticates reads and
mutations. Published scripts cannot use its API. Browser session tokens cannot
control the native daemon API, and the daemon secret is never given to the
browser. There is no permissive CORS or ambient localhost-cookie authority.
The cloud app, hosted MCP, cloud uploads and cloud deletions remain separate.

## Cloud uploads

`upload PATH` remains an explicit cloud-only operation. To share an existing local
snapshot, use `share LOCAL_ID` as documented below. Publish never uploads or syncs.
Local and cloud deletion are independent. Local 10 MiB snapshots can exceed the
cloud 8 MiB limit; local 30-day/1 GiB policy does not promise permanent offline retention.


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


## Share a local snapshot

```sh
plansplease publish --json ./artifact/
plansplease share --json LOCAL_ID
plansplease share --inspect --json LOCAL_ID
plansplease share --operation OPERATION_KEY --json LOCAL_ID
```

Share uses the selected profile's existing cloud credential without opening
browser sign-in. `--open` explicitly opens a confirmed cloud link. The command
checks the authenticated account and receipt-protocol capability before admission;
older servers fail closed. It does not fall back to legacy unkeyed upload.

The daemon reads the committed immutable snapshot once under its read lease and
mutation gate, preserving its local ID, generation, encoded bytes and SHA-256.
Folders use the existing encoded bundle, including supported binary assets,
without rereading the original folder or encoding it again. A private SQLite v3
attempt records account, origin, key and fingerprint before the CLI can receive
upload bytes. No credential is stored in attempts. Older binaries refuse v3
storage; stop the daemon before changing installations and use a compatible build.

Only the first invocation receives bytes for admission. Concurrent or repeated
invocations use the existing key. Unknown/pending operations perform authenticated
receipt lookup only, including after daemon restart or local deletion. A missing
receipt is not proof that an earlier admission cannot commit. Never replace an
unknown key or manually resend it. If a local prepare acknowledgement is lost,
inspect this ID's stored attempts and run share again. No background retry runs.

JSON stdout contains separate `local`, `cloud`, `bookkeeping` and `recovery`
fields. Cloud `committed` includes the account/origin/document identity and verified
receipt. Cloud `failed` can mean local size/format refusal, verified terminal
server failure, or preflight refusal before this invocation starts admission;
preflight refusal leaves previous operations unchanged. `unknown` means no final
outcome is proven. A known cloud commit can have `bookkeeping: "unknown"` if the
local receipt write could not be confirmed; keep its key and recover by lookup.
Exit 0 means committed and locally recorded; exit 1 covers failure or uncertainty.
No snapshot bytes or credential are printed. Help performs no daemon/cloud work.
`--inspect` is local-only, starts/reuses the daemon because it owns metadata, and
returns the 20 newest attempts with `hasMore`; `--operation` selects an older key.

After a proven terminal failure, `share --new-attempt LOCAL_ID` deliberately
allocates a new key in the same current account/origin. It is refused for unknown
or committed operations. Old attempts remain inspectable. Switching accounts or
origins creates a separate scope; recovering a named operation requires its original
account and origin. Revoked credentials cannot recover or admit uploads.

Snapshots above 8 MiB remain local, with `CLOUD_SIZE_LIMIT` and no provider upload.
Local bundle types unsupported by the cloud similarly report `CLOUD_FORMAT_REFUSED`.
The local URL and expiry remain visible. Sharing does not refresh access retention,
pin a snapshot, protect it from explicit deletion, or promise permanent offline
copies. Receipt history survives local/cloud deletion and does not recreate bytes.
There is a fixed 10,000-attempt/profile metadata cap with no silent eviction;
receipt metadata is outside the logical document-byte quota. Reconciliation of
uncertain provider ingestion and attempt compaction remain manual/operator work.

## Manual dev/alpha candidates

Candidates are prepared artifacts, not published releases. See
[candidate preparation and transfer](../../docs/prerelease-artifacts.md) for exact
source receipts, pinned Node/npm and offline cache requirements. The CLI tarball
requires external Effect 4.0.6 and is not self-contained. Before starting one, run
`plansplease build-info` to inspect its source SHA, channel and version offline.
A candidate refuses to reuse a profile daemon from a different build. Inspect
`status --json`, then deliberately `stop` that profile before starting the new
candidate. Existing preview links stop with that daemon; other profiles remain
independent. Preparation does not publish, move tags or change local/cloud data.
