# Run the whole product locally

Use Node 24.19.0 and npm 11.16.0. From the repository root:

```sh
npm ci
npm run local
```

Open **http://127.0.0.1:3000** and choose **Create a local test account**.
Use any test email and a password of at least 12 characters. No email is sent.
These are real Better Auth accounts and sessions in an anonymous local Convex
backend. No Convex account, GitHub app, UploadThing token, or paid hosting is
required. The first run downloads Convex's backend binary and dashboard; the
CLI can also check for updates. It does not provision or update a cloud deployment.

Keep the terminal open. Ctrl-C stops the app, backend, marketing site, and docs.
Start the same command again to resume your accounts, sessions, and documents.

- App and sign-in: http://127.0.0.1:3000
- Marketing: http://127.0.0.1:4300
- Documentation: http://127.0.0.1:4301
- Account-scoped MCP endpoint: http://127.0.0.1:3000/mcp
- Convex client API: http://127.0.0.1:3210
- Convex HTTP actions: http://127.0.0.1:3211

Use the exact `127.0.0.1` origins above, including when opening the app on this
computer. The runner binds the web servers to loopback, checks all five ports,
and refuses to start if one is occupied. Stop an earlier local stack before
starting another checkout. Do not expose these development services through a
public proxy or tunnel.

Convex 1.46's CLI does not forward its native backend's bind-interface setting.
The runner applies a small Node preload only to its Convex CLI child processes
to pass `--interface 127.0.0.1` to native backend server launches. Key generation,
help, and unrelated processes keep their normal behavior. This adaptation changes
no installed dependency or cached binary; review it when updating the pinned CLI.

## Browser documents

Choose **Upload document** on the Documents page. Drop one `.html` file or use
the keyboard-accessible file picker, edit the title, then choose **Save document**.
You can also select a `.planview` artifact bundle produced by the CLI. Uploads
have the same 8 MiB limit and account quota as hosted uploads.

Open the document title to preview it. Standalone HTML runs inside a sandboxed
iframe with an opaque origin. Bundles retain their relative CSS and JavaScript
paths. Use the row's actions menu and confirm **Delete** to remove a document.
Convex records deletion first; its background worker removes the bytes and then
releases the quota. A stopped app can delay that worker until the next restart.

## CLI against the local account

The startup command builds the real `plansplease` CLI. In a second terminal:

```sh
node apps/cli/dist/index.js --profile local-dev login --cloud-url http://127.0.0.1:3000
node apps/cli/dist/index.js --profile local-dev upload ./example.html
node apps/cli/dist/index.js --profile local-dev upload ./artifact-folder
node apps/cli/dist/index.js --profile local-dev logout
```

The login command opens a browser. Sign in with your local account, then choose
**Authorize local CLI**. The callback goes to a temporary loopback port on this
computer. If your terminal cannot open a browser, install/configure the operating
system's opener first, such as `xdg-open` on Linux. The printed URL identifies the
same authorization flow.

The explicit `local-dev` profile keeps its credentials separate from your default
CLI profile. Pick another profile name if you already use that name. Upload uses
the account and origin saved by login; it does not infer a cloud target from an
environment override. Logout revokes that credential. The CLI's separate `publish`
command still creates snapshots in its local daemon, without an app account.

## MCP on localhost

Point an HTTP-capable MCP client at `http://127.0.0.1:3000/mcp` and complete its
OAuth flow in the browser. Use the same local test account and choose **Allow
access**. Its tools list, read, upload, and delete documents belonging to that
account. HTML and artifact bundles use the same storage and quota path as the
browser and CLI. An unauthenticated request receives an OAuth challenge.

Local mode enables dynamic client registration because a localhost client cannot
publish an HTTPS metadata document. A client registering an HTTP loopback callback
must declare `application_type: "native"`, `token_endpoint_auth_method: "none"`,
and use authorization code with PKCE S256. The discovery URL is:

```text
http://127.0.0.1:3000/.well-known/oauth-authorization-server
```

This is the existing authenticated MCP service running locally. It does not accept
a CLI upload credential as an MCP access token. GitHub sign-in remains the hosted
sign-in method and is an independent optional integration, not a prerequisite for
local testing. The runner deliberately leaves GitHub credentials empty.

## Data, secrets, and source changes

Everything belonging to the app's local workspace lives in the ignored
`.planview-local/` directory in this checkout:

- `backend/.convex/local/default/` holds Convex's database and backend state.
- `storage/` holds immutable document bytes under hashed object filenames.
- `secrets.json` and `backend/backend.env` hold generated development secrets.
- `env/` is the dedicated env directory for the app, docs, and marketing dev servers.

The directory is private to your user. Secrets are generated once, reused on
restart, and never printed by the runner. Back up the entire directory while the
stack is stopped if you want to keep this dataset elsewhere.

The runner does not read or overwrite your existing `.env.local` files. It removes
inherited cloud deployment selections and provider credentials from child process
environments. All Convex commands use a generated anonymous deployment selection
and an isolated working directory. Do not run a separate `npx convex dev` in
`apps/app` for this local workflow.

The app isolates both dotenv loaders. Vite reads the generated env directory;
the local launcher also preinitializes Nitro with `dotenv: false` because this
Nitro Vite version otherwise loads source dotenv files independently of Vite's
`envDir`. The typed preinitialized-instance hook applies only in explicit local
mode. Ordinary app development and hosted builds keep their existing loader.

App, marketing, and docs edits reload normally. Convex source is mirrored into the
generated project because Convex's component bundler requires physical source
paths. Additions, renames, and deletions are mirrored. Convex deploys that copy to
the local backend and the runner copies only generated API bindings back to
`apps/app/convex/**/_generated/`, so frontend types follow new queries and mutations.
Review generated binding changes with the code that required them. Changes to the
runner itself require a restart.

Email/password authentication and filesystem storage require explicit local mode,
a non-production process, a loopback app origin, and a loopback Convex backend
origin. Hosted deployments retain their existing GitHub and UploadThing behavior.
Filesystem locators are owner-scoped and signed before admission to Convex;
reservations, quota accounting, and retryable deletion remain active locally.
Reads and deletion callbacks use expiring signed capabilities. The byte endpoint
never accepts arbitrary filesystem paths.

## Reset explicitly

First log out the CLI profile while the stack is still running, then stop the
stack with Ctrl-C. Reset requires the explicit `--yes` flag:

```sh
node apps/cli/dist/index.js --profile local-dev logout
# Stop npm run local in its terminal, then:
npm run local:reset -- --yes
npm run local
```

Reset permanently deletes this checkout's local accounts, sessions, metadata,
document bytes, and generated secrets. It refuses to run while the local runner
is alive. It does not remove other CLI profiles or daemon snapshots, Convex's
shared binary cache, or any hosted provider account. Browser cookies from the old
dataset become invalid; create a new local account after reset.

## Check the local changes

Focused checks do not require the stack:

```sh
node --test scripts/local-dev.test.mjs
node --test scripts/local-convex-loopback.test.mjs
npm run build --workspace @planview/core
npm run typecheck:test --workspace @planview/app
node --experimental-strip-types --test apps/app/test/local-development.test.mts apps/app/test/storage-quota.test.mts apps/app/test/document-storage.test.mts apps/app/test/document-deletion-storage.test.mts
node --experimental-strip-types --test apps/app/test/local-env-isolation.test.mts
```

For the real integration, run the browser, CLI, and MCP flows above, restart the
stack, and confirm that the same account still opens the same document bytes.
Use a second local account to confirm it cannot list, preview, or delete the first
account's documents. Unit tests cover boundaries and filesystem behavior; these
manual checks exercise the actual local backend and browser.

Run `npm run verify`, `npm run changeset:status`, and `npm run pack:check` before
review. These checks neither require nor deploy the local stack.
