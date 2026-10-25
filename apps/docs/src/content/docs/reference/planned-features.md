---
title: Hosted availability and proposals
description: Current hosted service availability, repository capabilities, and proposals.
---
<span id="current-staging-workflows"></span>

## Hosted availability

Status checked **23 October 2026**. Railway hosting is paused and offline: all
three staging services are stopped, two production services are placeholders that
were never deployed, and automatic deployments are disabled. Hosted app, docs,
and marketing workflows are unavailable. Do not treat configured URLs or merged
code as evidence that a hosted workflow can be used. For a working walkthrough,
use the [full local workspace](../development/#full-local-workspace).

<span id="merged-changes"></span>

## Implemented in this repository

The following behavior is implemented in the current source and can be exercised
locally with `npm run local`:

- Account sign-in, standalone HTML uploads, account-owned previews, and OAuth MCP.
- CLI folder uploads and MCP bundle tools, including relative asset previews.
- Cloud account quotas and provider-backed storage with deferred cleanup.

Hosted use of these features requires running compatible app and Convex releases.
Bundle previews pass through the app with a bounded cache and consume app
bandwidth; UploadThing alpha objects have public URLs. The quota and provider
changes require a coordinated deployment order documented in the app workspace
README for operators.

<span id="open-implementations"></span>
<span id="proposals-only"></span>

## Proposals and open work

- [Unlisted sharing, #130](https://github.com/abijith-suresh/plansplease/pull/130): optional bearer links with rotation, revocation, and noindex. It is not available.
- [Revisions, #123](https://github.com/abijith-suresh/plansplease/pull/123): define stable document identity, version URLs, and agent behavior before changing uploads.
- [Self-hosting, #129](https://github.com/abijith-suresh/plansplease/pull/129): define supported installation, authentication, storage, persistence, and upgrade contracts.
- [Naming and environments, #122](https://github.com/abijith-suresh/plansplease/pull/122): resolve repository/product naming and environment plans.

There is no supported home-server installation, private-storage migration,
paid storage tier, anonymous share link, or automatic revision behavior.
