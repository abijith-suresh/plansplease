---
name: planview
description: Preview immutable local HTML snapshots and save or retrieve cloud documents through plansplease CLI and hosted MCP.
metadata:
  author: planview
  version: "0.2"
---

# plansplease

Use plansplease to give agent-generated HTML a local URL or save a standalone page to
plansplease. The command is `plansplease`; the installed skill directory remains
`planview`. Choose the workflow that matches where the page needs to live.

## Local preview

Publish a `.html` or `.htm` file, or a folder with a root `index.html` and its assets:

```sh
plansplease publish --open ./report.html
plansplease publish --open ./site
```

Omit `--open` when you only need the URL. Local source snapshots have a 10 MiB limit;
bundles accept up to 512 files. Follow source-validation errors rather than stripping
assets to force publication.

Each URL is immutable. Changing the source does not change a published snapshot.
Publish again after editing. Use the exact printed URL; the daemon prefers port 4777
and selects another port when needed.

```sh
plansplease get <id-or-exact-local-url> > recovered.html
plansplease publish --json ./report.html
```

`get` writes exact standalone HTML bytes. It does not follow a folder-root redirect;
use the browser to view a folder's `index.html` and asset paths.

The daemon starts on demand. `start`, `status`, `stop`, `restart`, and `clean` manage
it; `status` is read-only. Unpinned local snapshots expire after 30 days without access.

## Cloud upload from the CLI

Sign in once, then upload a standalone `.html` file or an artifact folder up to 8 MiB including its manifest:

```sh
plansplease login
plansplease upload --open ./report.html
plansplease upload --json ./report.html
plansplease upload ./artifact/
```

`upload` returns the document's workspace preview link. The preview requires the
owning account to be signed in; it is not an anonymous share link. CLI credentials
permit uploads only. `get` reads local snapshots, not cloud documents. To list or
read cloud documents, use hosted MCP or the workspace. `plansplease logout` revokes the
credential and requires a connection.

Use `PLANVIEW_CLOUD_URL` or `plansplease login --cloud-url <origin>` for a different app.
The selected cloud URL and credential are saved in the active CLI profile.

## Hosted MCP

When the plansplease MCP server is connected, use its tools directly. The endpoint
is `<app-origin>/mcp`; connecting requires browser sign-in and explicit consent.
Do not copy CLI credentials into MCP configuration.

- `list_documents` lists cloud documents. Pass its `nextCursor` as `cursor` to
  request the next page until `nextCursor` is `null`.
- `read_document` retrieves HTML in chunks of up to 32,768 characters. Continue
  with the same `id` and pass `nextOffset` as `offset` until it is `null`.
- `list_bundle_files` lists up to 50 files in a bundle. Pass `nextOffset` as `offset`
  to continue. Bundle documents report `kind: "bundle"` in listing results.
- `upload_bundle` saves one artifact. Pass `title` and `files`, each with a relative
  `path` and UTF-8 `content`. Include `index.html`; use URL-safe paths. Keep the
  encoded bundle within 8 MiB and 512 files. MCP accepts text assets only; the CLI
  folder flow also supports common image, font, and video assets.
- `upload_document` saves a new standalone HTML document. Pass `title` and `html`,
  with a title of 1 to 200 characters and a maximum UTF-8 HTML size of 8 MiB.
  Each upload creates a separate document.
- `delete_document` takes an `id`, hides the document, and queues storage deletion. Confirm the
  user's intent before deleting work they may want to keep.

For bundle reads, `read_document` defaults to `index.html`. Supply `path`, such as
`styles/main.css` or `scripts/main.mjs`, to inspect a text asset. Its existing `html`
result field contains the selected text, with `path` and `kind` identifying the
bundle read. Binary assets are listed but cannot be read as UTF-8 text through MCP.

There is no revision or update tool yet. Keep the original document when creating
a revised upload, and identify both documents clearly in your response.

## Boundaries

- Cloud file URLs are public during alpha. Do not describe uploads as private.
- Keep the daemon on loopback. Local URLs do not work on another person's machine.
- Pass real source paths and preserve exact document IDs. Do not pass symlink
  sources or unvalidated shell substitutions.
- Errors go to stderr; successful results go to stdout. Commands supporting
  `--json` emit one JSON value. Check exit status before presenting success.


Local inventory is available with `plansplease list --limit 50 --json`; follow
`nextAfter` with `--after` for the next bounded page. Listing does not extend
retention. `plansplease usage --json` reports logical committed storage and quota,
not physical disk use. Both commands start or reuse the selected profile daemon.
For an explicitly requested local deletion, use `plansplease delete ID
--generation GENERATION --json` with the generation returned by list. Active
reads return retained; stale generations require a fresh selection. Partial
outcomes report `recovery: "clean"` and require bounded reconciliation, possibly
after the orphan grace period. Local deletion never deletes a cloud copy.


For an explicitly requested human browser manager, run `plansplease ui` and give
the user its private one-use launch link, or use `ui --open` only when opening
the browser is requested. Launch codes expire after one minute; browser sessions
remain in page memory for up to eight hours. Never log or share these links
outside the current user session. `ui --json` returns url, origin and expiresAt.
The UI and previews use separate origins within the same daemon. Stopping the
daemon stops both. There is no browser query editor, cloud mutation, folder
import or profile switcher in this slice. Agents should continue using the CLI's
bounded list/usage/delete operations directly.


## Explicit local-first sharing

Use `plansplease share --json LOCAL_ID` only when cloud sharing is requested.
`publish` remains local-only, and `upload PATH` is the compatible explicit
cloud-only path. Share uses daemon-owned immutable snapshot bytes, including
encoded folders, without recapturing the original source. It records a scoped
operation key before remote admission. Use the existing configured credential;
share does not open browser sign-in. Opening a confirmed link requires `--open`.

Read `local`, `cloud`, `bookkeeping` and `recovery` from JSON. A failed cloud step
keeps local data. Local 10 MiB versus cloud 8 MiB refusal reports `CLOUD_SIZE_LIMIT`.
Local 30-day/1 GiB retention is not permanent offline storage, and share does not pin.
Deletion is independent. Never delete the local snapshot to compensate cloud failure.

For pending/unknown outcomes run `share --operation KEY --json LOCAL_ID` with the
original account/origin. It only looks up the receipt, never resends bytes. A 404
or timeout does not prove admission failed. Never replace an unknown key. Local
receipt-write uncertainty after cloud commit also needs lookup. `share --inspect
--json LOCAL_ID` uses daemon-owned bounded local metadata with no cloud request.
Only a proven terminal failure permits deliberate `share --new-attempt LOCAL_ID`.
Older servers, wrong account/origin and conflicting receipts fail closed.


For explicitly requested offline retention, list first, then use `plansplease pin
ID --generation GENERATION --json` on that existing immutable generation. Never
auto-pin on publish/share. Pins survive automatic cleanup but count toward the
finite 1 GiB logical quota; full pinned storage refuses new publication/import.
`usage --json` includes pinnedCount and pinnedBytes. Inventory and share local
outcomes have pinned, expiresAt=null while pinned, and unpinnedExpiresAt.

Before `plansplease unpin ID --generation GENERATION --json`, explain that the
original access-based expiry returns without renewal. If it has passed, cleanup
can remove the copy promptly. Pins are not backups or permanent availability.
Manual selected delete can delete pins; cloud copies/receipts remain independent.
After lost/unconfirmed pin responses inspect list for the same generation.
Neither command silently selects a replacement or resurrects a missing copy.


Use `plansplease profiles list --json` for offline bounded directory discovery.
It does not open SQLite, credentials or cloud connections, check every daemon,
or recurse into artifacts. Daemon state is deliberately not_checked. Follow
`limited` and `skippedEntries`; the list can be partial. `profiles current --json`
checks only the selected daemon and distinguishes unavailable from stopped.

`profiles select NAME --json` prints validated launch instructions; it never
persists a global default or starts/stops a daemon. Run `plansplease --profile
NAME ui` deliberately, adding `--open` only for explicit browser opening.
`profiles create NAME --json` creates directories only, with no service/database.
Default keeps the original root; named profiles use profiles/NAME. Custom
app-data/runtime overrides remain isolated. Remove those overrides before using
cross-profile launch instructions. The manager only prepares a copyable command;
it cannot launch/mutate another profile or transfer its browser session.

Each intentionally active profile retains its own daemon and preview/manager
origins. Leaving or selecting never stops an old profile: its links may still be
needed. Stop each with `plansplease --profile NAME stop`. Fixed 30-day unpinned
retention/1 GiB quota apply per profile. No profile delete, rename or purge exists.
On Windows, profile ownership checks use a bounded hidden PowerShell ACL helper;
if the OS policy blocks it, discovery fails closed without starting a service.
