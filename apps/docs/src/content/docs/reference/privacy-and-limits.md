---
title: Privacy and limits
description: What account access protects, what is public during alpha, and the current size limits.
---
## Cloud alpha

Hosted services are currently offline; see [hosted availability](../planned-features/)
and use the [local workspace](../development/#full-local-workspace) for testing.

The workspace checks who owns a document before listing, reading, or deleting
it through the app. MCP tools are scoped to the account that authorized the client.

**UploadThing files have public direct URLs during alpha.** Someone who obtains
an object URL can fetch its bytes without your workspace session. Account checks
and sandboxing do not make those stored objects private. Use non-sensitive test
content when trying the product with friends.

Unlisted sharing is not available; see the
[features reference](../planned-features/) for its proposal status.

## Rendering

Uploaded HTML runs in an opaque-origin sandbox without access to the workspace's
cookies or browser storage. Generated JavaScript can still execute and fetch
permitted external resources. Keep credentials out of document content.

A preview is not an offline archive of remote assets. If it references a hosted
font, image, stylesheet, or API, that provider can receive a request from the
viewer's browser.

## Limits on main

| Workflow | Limit |
| --- | --- |
| Local HTML or encoded artifact folder | 10 MiB per snapshot |
| Files in a local artifact folder | 512, with root `index.html` |
| Cloud HTML or artifact bundle | 8 MiB of encoded bytes |
| MCP document read | 32,768 characters per call |
| MCP document list | 50 records per page maximum |
| Local committed snapshots | 1 GiB logical quota, including 4 KiB per document for metadata |
| Cloud account quota implementation | Configurable; defaults to 500,000,000 bytes |

The local quota counts published HTML bytes plus a fixed metadata allowance; it
is a logical limit, not a bound on physical disk use. The cloud quota counts
stored files, reservations, pending deletion, and unresolved provider outcomes.
It releases charged capacity only after cleanup is confirmed. The object limit
uses binary MiB; the cloud account default uses decimal MB. See
[hosted availability](../planned-features/) before relying on cloud services.

Paid plans and unlimited storage are not available or promised. A cloud bundle's
complete encoded object, including its manifest, counts against the same quota.

## Local retention and deletion

Unpinned local snapshots expire 30 days after last successful access. Explicit
generation-bound pins prevent automatic expiry and space cleanup within the
finite 1 GiB logical quota. Pin/unpin never renew access. Unpin restores the
original access-clock expiry and an expired copy may be cleaned promptly. Pins
are not backups; manual selected deletion remains allowed.
Cleanup runs at startup and every 24 hours, or when `plansplease clean` runs.
Local state is private to the user profile and the daemon binds to loopback.

Cloud deletion hides the document and queues provider cleanup with retries.
Previously downloaded copies can remain elsewhere. There is no cloud retention
or automatic expiry promise today.

## Documentation itself

These docs are static and public. Search runs against a locally served Pagefind
index; there is no configured analytics service. Fonts are served with the docs.
Signing in happens on the separate app origin, not on this documentation service.
