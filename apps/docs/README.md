# plansplease documentation

An independent Astro and Starlight site. It has no cloud credentials, account
session, or imports from another application workspace. Search, fonts, and page
assets are served from the built site.

## Develop and verify

From the repository root, using the versions in `.node-version` and
`package.json`:

```sh
npm ci
npm run dev --workspace @planview/docs
npm run typecheck --workspace @planview/docs
npm test --workspace @planview/docs
npm run build --workspace @planview/docs
npm start --workspace @planview/docs
```

The tests build root and prefixed sites, validate generated links and search
artifacts, and exercise the production server.

## URLs and deployment

Public URLs are build-time settings. Copy `.env.example` to `.env.local` to
override them:

| Setting | Purpose |
| --- | --- |
| `PUBLIC_DOCS_URL` | Canonical docs origin and optional path prefix |
| `PUBLIC_APP_URL` | App links in docs |
| `PUBLIC_SITE_URL` | Marketing links in docs |

The production server reads `PORT` (4322 by default), serves built files, and
exposes `/health`. Deployments need public URL settings and Node, not cloud-app
secrets. Hosted service availability is tracked in the
[features reference](src/content/docs/reference/planned-features.md).

## Content routes

Keep these public routes and legacy entry links working:

- `/`, `/guides/install-cli/`, `/guides/cli/`, and `/guides/mcp/`
- `/guides/self-hosting/`, `/getting-started/`, and `/reference/development/`
- Marketing `/docs/`, `/cli/`, and `/mcp/` links to the canonical docs routes.

The old `/getting-started/` route remains a setup chooser. Self-hosting remains a
proposal; development instructions are not a supported installation recipe.
