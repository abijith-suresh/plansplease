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
it; `status` is read-only. Local snapshots expire after 30 days without access.

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
