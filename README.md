# plansplease

`plansplease` publishes an HTML file or artifact folder as an immutable local
preview. It can also upload the same inputs to an account workspace when a
compatible app and backend are available. The repository includes the CLI,
local daemon and storage packages, cloud app, marketing site, and documentation.

The command replaces the former `planview` executable. Update existing scripts
to use `plansplease`; profiles, documents, credentials, daemon state, data paths,
`PLANVIEW_*` settings, package names, and installed skill directories retain
their existing names.

## Develop

Use Node.js 24.19.0 and npm 11.16.0:

```sh
npm ci
npm run local
```

Open `http://127.0.0.1:3000` to create a local test account. The local workspace
runs the app, Convex backend, filesystem storage, marketing site, and docs without
cloud provider accounts. Data persists across restarts. See the [development
guide](apps/docs/src/content/docs/reference/development.mdx#full-local-workspace)
for CLI, MCP, and reset instructions.

Run the repository checks with:

```sh
npm run verify
```

The [CLI guide](apps/cli/README.md) covers local snapshots and cloud uploads.
The [docs workspace guide](apps/docs/README.md) covers documentation development.

## CI and releases

CI runs the Node 24 quality gate on Linux for pull requests and pushes to `main`.
It also smoke-tests packed CLI installs on macOS and Windows. A push to `main`
validates the repository, then Changesets creates or updates the
`changeset-release/main` version PR. Merging that PR runs the release command.
The package is not published to npm unless maintainers enable publishing.

See [CONTRIBUTING.md](CONTRIBUTING.md) for verification, Changeset, and release
requirements. Hosted service availability and proposals are tracked in the
[features reference](apps/docs/src/content/docs/reference/planned-features.md).
